// mcpfabric 凭据只允许来自环境或受保护配置，禁止源码回退秘密。
import fs from 'node:fs';

export function loadMcpfabricToken() {
  const env = String(process.env.MCPFABRIC_TOKEN || '').trim();
  if (env) return env;
  const file = process.env.MCPFABRIC_TOKEN_FILE || '/etc/habitat/mcpfabric.token';
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  throw new Error('MCPFABRIC_TOKEN 未配置：请设置环境变量或写入受保护的 /etc/habitat/mcpfabric.token');
}
