# dsh-research（资料网）

动手之前先上网查社区，而不是闭门造车。

- **右上角按钮**：点开维护一份「资料站点清单」（GitHub / Bilibili / 贴吧 / 知乎 / CSDN / Stack Overflow，可增删启停排序）
- **查阅动画**：助手真正去查资料时，按钮会展开成小窗，线框地球上有一道光点从一个站点飞到另一个站点
- **闸门**：改文件 / 跑命令 / 写代码之前，如果 15 分钟内没查过资料，工具调用会被拒绝一次，拒绝理由里会教它怎么用 `site:github.com xxx` 检索
- **闸门强度**：`gate.mode` 可切三档（默认 `observe`）——`observe` 判定照常跑但不拒绝，只在日志里记一条「本应拦截」；`block` 是真拦截（旧行为）；`off` 完全不判定也不注入提示词
- **防死循环**：同一 agent 最多拦 2 次，第 3 次放行；查过一次后拦截配额清零

## 数据

站点清单：`~/.dsh/research/sites.json`（原子写，损坏时回退默认值且不覆盖原文件）
日志：`~/.dsh/research/log.jsonl`。闸门的每条判定记录带 `ts` / `agent` / `action`（`write_file` / `run_cmd` / `install`）/ `target`（文件路径或命令首词）/ `lastLookupAgoSec`（从未查阅为 `null`）/ `wouldBlock` / `mode`。

## 接口（本机）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/research/config.json` | GET | 读站点清单 |
| `/api/research/config.json` | POST | 保存站点清单（body ≤ 64KB） |
| `/api/research/ping.json` | GET | 计数 + 最近查阅时间（前端 1.4s 轮询） |
| `/api/research/reset.json` | GET | 恢复默认站点 |

双写路径：`/api/research/*` 与 `/research/*`。

## 边界

- 纯插件实现：不 spawn、不起端口、不访问网络、不依赖 Python/CLI
- 只放行本机请求（127.0.0.1 / ::1）
- 闸门内部任何异常都放行（fail-open），不会把宿主带崩
- 总开关：`cordis.patch.yml` 里 `enabled: false`；只想观察不想拦就用 `gate.mode: observe`
- `gate.actionRules` 是阶段一预留的分级默认值（放行新建文件 / 改插件自身目录 / 纯文本 .md、.txt、.json；需查阅改已有代码文件、`run_cmd`、`install`），判定尚未使用

## 卸载/回滚

profile 的 `package.json` 里删掉 `link:` 依赖与 `dsh.profile.bundles` 里那一行，再删 `node_modules\dsh-research` junction，重启 DSH。
