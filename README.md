# habitat-plugins

Habitat 的独立应用插件索引与制品。本体与应用分开：应用插件拥有自己的版本、权限、制品、哈希、签名和许可。

## 当前应用

- `app-qq`：OneBot 连接监督、ResidencePolicy 与受限 `qq.reply`；
- `app-bilibili`：B站 WBI/WSS 弹幕读取与连接监督；
- `app-mc`：mcpfabric 文字观测与闭集 MC 动作。

HLS 暂不单独发布，因为它与 Desktop/Audio 的共享运行时边界还需要独立拆分。

## 索引协议

- `index.json`：插件 id、版本、apiRange、入口、权限、生命周期、制品 URL 和 SHA256；
- `index.sig.json`：整个索引的 Ed25519 签名；
- `revocations.json`：撤销列表，禁止新激活；
- `release-public-key.pem`：只包含公钥，不包含签名私钥。

```bash
node tools/build-plugin-packages.mjs
node tools/sign-plugin-index.mjs
node tools/verify-plugin-index.mjs
```

插件安装必须经过主人批准。普通模型、观众、群消息不能安装插件或扩大权限。插件源先采用 GitHub 静态索引与 Release 制品，不依赖自建服务器。

## 许可

索引和本仓库自制代码采用 [MIT](LICENSE)。QQ、B站、MC 插件包的实现分别独立分发，NapCat、mcpfabric、Minecraft、平台 SDK、模型和角色资源不因被适配而自动改授 MIT。详见 [NOTICE.md](NOTICE.md)。
