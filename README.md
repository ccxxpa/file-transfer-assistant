# 文件传输助手

自托管的跨设备文字和文件传输工具，手机、电脑打开网页即可使用。

- 文字、链接、图片和文件共享，消息实时同步
- 历史记录保存在服务器，发送设备离线后仍可查看
- 搜索、按日期清理、最近删除与恢复
- 密码访问，支持 Docker / NAS 部署

## Docker 启动

镜像支持 `amd64` / `arm64`，无需登录即可拉取。直接运行：

```bash
docker run -d --name file-transfer-assistant --restart unless-stopped --init \
  -p 4826:4826 -e ALLOW_REMOTE_SETUP=true \
  -v "$PWD/assistant-data:/data" \
  ghcr.io/ccxxpa/file-transfer-assistant:1.2.1
```

或使用 Compose：

```bash
git clone https://github.com/ccxxpa/file-transfer-assistant.git
cd file-transfer-assistant
docker compose pull
docker compose up -d
```

打开 `http://服务器IP:4826`，首次访问设置密码。公网使用请配置 HTTPS。

数据保存在 `./assistant-data`，升级时保留此目录。默认单文件上限 100 MB、总容量 5 GB；Compose 部署可将 `.env.example` 复制为 `.env` 后调整。另提供 `latest` 标签。

## 本地运行

需要 Node.js 24+。

```bash
npm ci
npm start
```

打开 `http://localhost:4826`，数据保存在 `./data`。运行测试：`npm test`。

## 许可证

[GPL-3.0](LICENSE)。起始工程来自 [PairDrop](https://github.com/schlagmichdoch/PairDrop)，本仓库发布独立的文件传输助手。图标使用 [Lucide](https://lucide.dev)，详见 [第三方说明](NOTICE.md)。
