"""Generate first-install credentials locally; never print them or rotate existing ones."""
from pathlib import Path
import os, re, secrets
root = Path(__file__).resolve().parent
target = root / '.env'
if target.exists():
    raise SystemExit('Configuration already exists; preserving credentials.')
settings = {
    'FQDN':'bop.taild88607.ts.net:8443', 'SCHEME':'https', 'WS_SCHEME':'wss',
    'POSTGRES_PASSWORD':secrets.token_hex(24),
    'AWS_ACCESS_KEY':'proxima'+secrets.token_hex(8), 'AWS_SECRET':secrets.token_hex(32),
    'GOTRUE_ADMIN_EMAIL':'owner@proxima.internal', 'GOTRUE_ADMIN_PASSWORD':secrets.token_urlsafe(24),
    'GOTRUE_JWT_SECRET':secrets.token_hex(48), 'GOTRUE_DISABLE_SIGNUP':'true',
    'GOTRUE_MAILER_AUTOCONFIRM':'true', 'GOTRUE_SMTP_HOST':'', 'GOTRUE_SMTP_USER':'',
    'GOTRUE_SMTP_PASS':'', 'GOTRUE_SMTP_ADMIN_EMAIL':'',
    'APPFLOWY_MAILER_SMTP_HOST':'', 'APPFLOWY_MAILER_SMTP_USERNAME':'', 'APPFLOWY_MAILER_SMTP_PASSWORD':'',
    'APPFLOWY_DATABASE_MAX_CONNECTIONS':'12', 'AI_ENABLED':'false', 'AI_OPENAI_API_KEY':'',
    'APPFLOWY_INDEXER_ENABLED':'false', 'APPFLOWY_BACKUP_PROFILE':'',
    'COMPOSE_FILE':'docker-compose.yml:compose.proxima.yml', 'COMPOSE_PROJECT_NAME':'proxima-appflowy',
}
text = (root / 'deploy.env').read_text()
for key, value in settings.items():
    pattern = rf'^{re.escape(key)}=.*$'
    if re.search(pattern, text, re.M): text = re.sub(pattern, key+'='+value, text, flags=re.M)
    else: text += '\n'+key+'='+value+'\n'
fd = os.open(target, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream: stream.write(text)
print('Private server configuration created. Account credentials remain in .env on BOP.')
