import asyncio
import os
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, '/home/zcode/aegismesh')
sys.path.insert(0, '/home/zcode/aegismesh/backend')

from backend.app.database import SessionLocal
from backend.app.models import Agent
from backend.app.services.registration import RegistryClient
from backend.app.services.certificates import issue_certificate

async def sync_approved():
    client = RegistryClient()
    db = SessionLocal()
    agents = db.query(Agent).filter(Agent.transport != 'aip-rpc').all()
    any_approved = False
    
    for a in agents:
        if not a.registration_agent_id:
            continue
        try:
            detail = await client.detail(a.registration_agent_id)
            status = (detail.get("approvalStatus") or detail.get("approval_status") or "").upper()
            aic = detail.get("aic")
            print(f"[{a.id}] status={status} aic={aic}")
            if status == "APPROVED" and aic:
                a.registration_status = "approved"
                a.aic = aic
                comments = detail.get("comments") or detail.get("processComments") or detail.get("process_comments")
                a.registration_message = str(comments or "审核通过")[:500]
                a.registration_synced_at = datetime.now(timezone.utc)
                db.commit()
                any_approved = True
                
                # Fetch EAB and issue certificate
                try:
                    cred = await client.fetch_eab(aic)
                    issued = await issue_certificate(aic, {"keyId": cred.key_id, "macKey": cred.mac_key})
                    a.eab_key_id = cred.key_id
                    a.certificate_issued_at = datetime.now(timezone.utc)
                    db.commit()
                    print(f"  -> Certificate issued: {issued.cert_path}")
                except Exception as ce:
                    print(f"  -> Cert issuance error: {ce}")
            elif status == "REJECTED":
                a.registration_status = "rejected"
                comments = detail.get("comments") or detail.get("processComments") or detail.get("process_comments")
                a.registration_message = str(comments or "审核未通过")[:500]
                db.commit()
        except Exception as e:
            print(f"[{a.id}] check error: {e}")
            
    leader = db.get(Agent, 'research_leader')
    if leader and leader.aic and leader.registration_status == 'approved':
        leader_cert = f"/home/zcode/aegismesh/backend/data/certs/{leader.aic}.pem"
        leader_key = f"/home/zcode/aegismesh/backend/data/certs/{leader.aic}.key"
        if os.path.exists(leader_cert) and os.path.exists(leader_key):
            env_path = '/home/zcode/aegismesh/.env'
            with open(env_path, 'r') as f:
                lines = f.readlines()
            new_lines = []
            for line in lines:
                if line.startswith('LEADER_AIC='):
                    new_lines.append(f'LEADER_AIC={leader.aic}\n')
                elif line.startswith('AIP_CERT_FILE='):
                    new_lines.append(f'AIP_CERT_FILE={leader_cert}\n')
                elif line.startswith('AIP_KEY_FILE='):
                    new_lines.append(f'AIP_KEY_FILE={leader_key}\n')
                elif line.startswith('AIP_TLS_CERTFILE='):
                    new_lines.append(f'AIP_TLS_CERTFILE={leader_cert}\n')
                elif line.startswith('AIP_TLS_KEYFILE='):
                    new_lines.append(f'AIP_TLS_KEYFILE={leader_key}\n')
                else:
                    new_lines.append(line)
            with open(env_path, 'w') as f:
                f.writelines(new_lines)
            subprocess.run(["sudo", "systemctl", "restart", "aegismesh", "aegismesh-mtls"], check=False)
            print("  -> Services restarted with new leader cert.")
            
    db.close()
    return any_approved

if __name__ == '__main__':
    asyncio.run(sync_approved())
