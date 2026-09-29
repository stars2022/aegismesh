from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from app.services import certificates as service

AIC = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"
OTHER_AIC = "1.2.156.3088.1.BUPT.L2K8YU.9FTJ5K.FUG31M.0VW4"
HOST = "aip.example.com"


def key_pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


@pytest.fixture
def pki(tmp_path):
    now = datetime.now(timezone.utc)
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root")])
    root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
            .public_key(root_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=5))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
            .sign(root_key, hashes.SHA256()))
    trust = tmp_path / "ca.pem"
    trust.write_bytes(root.public_bytes(serialization.Encoding.PEM))

    def issue(key=None, aic=AIC, usage="serverAuth", hostname=HOST, expired=False):
        key = key or ec.generate_private_key(ec.SECP256R1())
        sans = [x509.UniformResourceIdentifier(f"acps://{aic}")]
        if hostname:
            sans.append(x509.DNSName(hostname))
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, aic)]))
                .issuer_name(root_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(days=2))
                .not_valid_after(now + timedelta(days=-1 if expired else 2))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.SubjectAlternativeName(sans), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH if usage == "serverAuth"
                                                     else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
                .sign(root_key, hashes.SHA256()))
        return key, cert.public_bytes(serialization.Encoding.PEM)
    return issue, trust


def save_pair(tmp_path, pair):
    key, cert = pair
    cert_path, key_path = tmp_path / "leaf.pem", tmp_path / "leaf.key"
    cert_path.write_bytes(cert)
    key_path.write_bytes(key_pem(key))
    return cert_path, key_path


def test_server_certificate_checks_chain_hostname_identity_and_key(pki, tmp_path):
    issue, trust = pki
    cert, key = save_pair(tmp_path, issue())
    service.validate_certificate_files(cert, key, trust, AIC, "serverAuth", HOST)


@pytest.mark.parametrize(("kwargs", "error"), [
    ({"usage": "clientAuth"}, "用途错误"),
    ({"aic": OTHER_AIC}, "AIC 不一致"),
    ({"hostname": None}, "缺少 DNS/IP SAN"),
    ({"hostname": "other.example.com"}, "主机名校验失败"),
    ({"expired": True}, "过期"),
])
def test_reject_invalid_server_certificates(pki, tmp_path, kwargs, error):
    issue, trust = pki
    cert, key = save_pair(tmp_path, issue(**kwargs))
    with pytest.raises(service.CertificateError, match=error):
        service.validate_certificate_files(cert, key, trust, AIC, "serverAuth", HOST)


def test_reject_mismatched_key(pki, tmp_path):
    issue, trust = pki
    cert, key = save_pair(tmp_path, issue())
    key.write_bytes(key_pem(ec.generate_private_key(ec.SECP256R1())))
    with pytest.raises(service.CertificateError, match="私钥不匹配"):
        service.validate_certificate_files(cert, key, trust, AIC, "serverAuth", HOST)


def test_client_certificate_does_not_require_dns_san(pki, tmp_path):
    issue, trust = pki
    cert, key = save_pair(tmp_path, issue(usage="clientAuth", hostname=None))
    service.validate_certificate_files(cert, key, trust, AIC, "clientAuth")


def mock_ca(monkeypatch, pki, pair, failure=None):
    _, trust = pki
    service._ensure_cli_deps()
    class Client:
        def __init__(self, *args): pass
        def get_directory(self): pass
        def new_account(self, **kwargs): pass
        def new_order(self, aic, usage):
            assert usage == "serverAuth"
            if failure:
                raise service.AcmeError(failure)
            return {"finalize": "https://ca.test/finalize"}
        def finalize_order(self, url, csr): return {"status": "valid", "certificate": "https://ca.test/cert"}
        def get_certificate(self, url): return pair[1]
    monkeypatch.setattr(service, "_ensure_cli_deps", lambda: None)
    monkeypatch.setattr(service, "AcmeClient", Client)
    monkeypatch.setattr(service.httpx, "get", lambda *a, **k: httpx.Response(
        200, content=trust.read_bytes(), request=httpx.Request("GET", "https://ca.test/trust-bundle")))


@pytest.mark.parametrize("failure", ["CA unavailable", None])
def test_failed_issuance_preserves_working_certificate_key_and_trust(pki, tmp_path, monkeypatch, failure):
    issue, _ = pki
    pair = issue()
    output = tmp_path / "live"
    output.mkdir()
    key_path, cert_path, trust_path = [output / s for s in (f"{AIC}.serverauth.key", f"{AIC}.serverauth.pem", "trust-bundle.pem")]
    key_path.write_bytes(key_pem(pair[0]))
    cert_path.write_bytes(pair[1])
    trust_path.write_bytes(b"existing trust bundle")
    before = [p.read_bytes() for p in (key_path, cert_path, trust_path)]
    # Reproduce the production failure: filename says serverauth, EKU says clientAuth.
    mock_ca(monkeypatch, pki, issue(key=pair[0], usage="clientAuth"), failure)
    with pytest.raises(service.CertificateError):
        service.issue_certificate_sync(AIC, {"keyId": "test", "macKey": "test"}, "https://ca.test",
                                       str(tmp_path / "account.key"), str(output), "serverAuth", server_hostname=HOST)
    assert [p.read_bytes() for p in (key_path, cert_path, trust_path)] == before
    assert not list(output.glob(".issue-*"))


def test_successful_renewal_reuses_key_and_validates_before_activation(pki, tmp_path, monkeypatch):
    issue, trust = pki
    old = issue()
    key_path = tmp_path / f"{AIC}.serverauth.key"
    key_path.write_bytes(key_pem(old[0]))
    fresh = issue(key=old[0])
    mock_ca(monkeypatch, pki, fresh)
    result = service.issue_certificate_sync(AIC, {"keyId": "test", "macKey": "test"}, "https://ca.test",
                                           str(tmp_path / "account.key"), str(tmp_path), "serverAuth", server_hostname=HOST)
    assert Path(result.key_path).read_bytes() == key_pem(old[0])
    assert Path(result.cert_path).read_bytes() == fresh[1]
    assert Path(result.trust_bundle_path).read_bytes() == trust.read_bytes()


def test_invalid_usage_rejected_before_ca_access(tmp_path):
    with pytest.raises(service.CertificateError, match="usage"):
        service.issue_certificate_sync(AIC, {}, "", "", str(tmp_path), "wrong")
    assert not list(tmp_path.iterdir())
