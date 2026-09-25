import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, '/home/zcode/aegismesh')
sys.path.insert(0, '/home/zcode/aegismesh/backend')

from backend.app.database import SessionLocal
from backend.app.models import Agent
from backend.app.services.registration import RegistryClient
from backend.app.services.acs import build_acs
from backend.app.main import hosted_public_rpc_url
from backend.app.services.certificates import issue_certificate

async def reapply():
    client = RegistryClient()
    db = SessionLocal()
    
    # 1. Register and submit all local agents
    agents = db.query(Agent).filter(Agent.transport != 'aip-rpc').order_by(Agent.id).all()
    for a in agents:
        rpc_url = hosted_public_rpc_url(a)
        acs = build_acs(a, rpc_url)
        print(f"\n>>> 正在为 {a.name} ({a.id}) 创建新草稿并提交...")
        print(f"    RPC Endpoint: {rpc_url}")
        try:
            reg_id = await client.save_agent(a.name, "1.0.0", a.description or a.name, acs)
            print(f"    草稿创建成功: ID={reg_id}")
            a.registration_agent_id = reg_id
            a.registration_status = "pending"
            a.registration_message = "已重新提交审核"
            db.commit()
            
            await client.submit(reg_id)
            print(f"    提交审核成功: ID={reg_id}")
        except Exception as e:
            print(f"    提交失败: {e}")
            db.rollback()

    # 2. Wait and poll approval status
    print("\n>>> 等待平台自动审核 (约 10-30 秒)...")
    approved_agents = []
    for _ in range(12):
        await asyncio.sleep(3)
        all_approved = True
        for a in agents:
            if a.id in approved_agents:
                continue
            detail = await client.detail(a.registration_agent_id)
            status = (detail.get("approvalStatus") or detail.get("approval_status") or "").upper()
            aic = detail.get("aic")
            print(f"    {a.id} 当前审核状态: {status} (AIC: {aic})")
            if status == "APPROVED":
                a.registration_status = "approved"
                a.aic = aic
                comments = detail.get("comments") or detail.get("processComments") or detail.get("process_comments")
                a.registration_message = str(comments or "审核通过")[:500]
                a.registration_synced_at = datetime.now(timezone.utc)
                db.commit()
                approved_agents.append(a.id)
            elif status == "REJECTED":
                a.registration_status = "rejected"
                comments = detail.get("comments") or detail.get("processComments") or detail.get("process_comments")
                a.registration_message = str(comments or "被拒绝")[:500]
                db.commit()
            else:
                all_approved = False
        if len(approved_agents) == len(agents):
            print("\n>>> 全部智能体审核通过！")
            break

    # 3. Issue certificates for approved agents
    print("\n>>> 开始拉取 EAB 凭据并签发新证书...")
    for a in agents:
        if a.registration_status == "approved" and a.aic:
            try:
                print(f"    拉取 EAB: {a.id} ({a.aic})...")
                cred = await client.fetch_eab(a.aic)
                print(f"    签发证书: key_id={cred.key_id}...")
                issued = await issue_certificate(a.aic, {"keyId": cred.key_id, "macKey": cred.mac_key})
                a.eab_key_id = cred.key_id
                a.certificate_issued_at = datetime.now(timezone.utc)
                db.commit()
                print(f"    [成功] {a.id} 证书已就绪: {issued.cert_path}")
            except Exception as e:
                print(f"    [失败] {a.id} 签发证书失败: {e}")

    # 4. Update .env for leader if leader AIC changed
    leader = db.get(Agent, 'research_leader')
    if leader and leader.aic:
        print(f"\n>>> 校验主智能体 LEADER_AIC: {leader.aic}")
        leader_cert = f"/home/zcode/aegismesh/backend/data/certs/{leader.aic}.pem"
        leader_key = f"/home/zcode/aegismesh/backend/data/certs/{leader.aic}.key"
        
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
        print("    .env 文件已更新配置。")

    db.close()
    print("\n>>> 全部操作完成！")

if __name__ == '__main__':
    asyncio.run(reapply())
