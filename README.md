# biupc_monitor 409 / flush 修复版

修改点：

1. 默认每轮写入日期数从 3 提高到 20，可通过 `MAX_DATES_PER_FLUSH` 环境变量覆盖。
2. 新增 `FLUSH_ALL_MAX_DATES`，默认 200，用于手动清理积压。
3. `GITHUB_WRITE_RETRY` 默认从 3 提高到 6。
4. flush 日期排序改为优先写最新日期，避免历史补报压住今天数据。
5. 新增接口：`POST /api/flush-all?token=ADMIN_TOKEN`。
6. 保留 `latest.json` 维护逻辑，适配 GitHub Pages 看板。

部署后检查：

```text
/health
```

应看到：

```json
"maxDatesPerFlush": 20,
"flushAllMaxDates": 200,
"githubWriteRetry": 6
```

手动清理积压：

```bash
curl.exe -X POST "https://你的-biupc-render域名/api/flush-all?token=你的ADMIN_TOKEN"
```
