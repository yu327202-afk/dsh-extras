# dsh-imagegen-relay

把**多家生图渠道聚合成一个** OpenAI 兼容端点，供 [`dsh-image-gen`](https://www.npmjs.com/package/dsh-image-gen)
的 `openai-compat` provider 使用。

适配基线：**DSH Desktop core 0.1.5-rc.1**，profile 名 `desktop`。

---

## 它解决什么问题

`dsh-image-gen` 的 `openai-compat` provider **只能填一个 `baseURL`**，
而你手上有好几家生图渠道（价格不同、模型不同、额度不同）。

这个插件在 DSH 进程内起一个 `http://127.0.0.1:8788/v1` 端点，
按请求体里的**模型名前缀**把请求路由到对应上游：

```
myprovider/gpt-image-2   →  https://api.example.com/v1   （显式指定渠道）
gpt-image-2              →  按渠道顺序回落第一家           （不带前缀）
```

于是 `dsh-image-gen` 里**只填一个地址**就覆盖了全部渠道。

---

## 形态：随 DSH 启停，不留痕迹

这是按"不用时不占资源"设计的：

- 由 DSH 插件树加载，**随 DSH 启动而启动、随 DSH 退出而消失**
- **不**注册 Windows 服务、**不**写计划任务、**不**留常驻后台进程
- 用 `ctx.effect()` 托管 HTTP server，卸载插件时自动关闭监听
- 端口只绑 `127.0.0.1`，**仅本机可访问**，不对外暴露

---

## 安装

```powershell
dsh plugin --profile desktop add link:C:/dsh-imagegen-relay
```

> ⚠️ 路径不能含空格（pnpm 会按空格拆成垃圾依赖）。带空格时先建 junction：
> `mklink /J C:\dsh-imagegen-relay "<真实路径>"`

装完**重启 DSH**。然后确认它在跑：

```powershell
curl http://127.0.0.1:8788/health
```

`{"ok":true,"running":true,"port":8788,"channels":[...]}` 即正常。

### 在 dsh-image-gen 里填什么

| 字段 | 值 |
|---|---|
| provider | `openai-compat` |
| baseURL | `http://127.0.0.1:8788/v1` |
| apiKey | 任意非空字符串（中转自己管凭据，不看这个值） |
| model | `渠道id/模型名`，如 `myprovider/gpt-image-2` |

---

## 配置渠道

改 `~/.dsh/imagegen-relay.channels.json`，**保存即生效**（按 mtime 检查，无需重启）。
首次启动时会把内置示例落盘成这份文件，之后一律以文件为准。

```json
{
  "channels": [
    {
      "id": "myprovider",
      "label": "我的生图渠道",
      "base": "https://api.example.com/v1",
      "credentialRef": "P_MY_PROVIDER",
      "models": ["gpt-image-2", "gpt-image-2.5"]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 渠道标识，用在模型名前缀里。只允许字母数字与 `. _ -`，不能以符号开头 |
| `label` | 显示名，仅用于日志与 `/health` |
| `base` | 上游 OpenAI 兼容根地址，**到 `/v1` 为止，末尾不要斜杠** |
| `credentialRef` | `.credentials.yaml` 里 `refs` 段的**键名** |
| `models` | 该渠道的模型裸名数组（不带前缀） |

> 🔑 **`credentialRef` 只是键名，不是密钥本身。**
> 真实 key 写在 `~/.dsh/.credentials.yaml` 的 `refs` 段里：
>
> ```yaml
> refs:
>   P_MY_PROVIDER: sk-xxxxxxxx
> ```
>
> 插件通过 DSH 内置的 `credentials` 服务解析；该服务在个别版本上对参数有额外要求，
> 所以插件还带一条"直接读文件"的兜底路径。

配置写错时**启动即报错**并指明是第几条、哪个字段 —— 不会留到运行时神秘失败。

---

## 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查，含当前生效的渠道列表 |
| GET | `/v1/models` | 聚合模型清单（带渠道前缀） |
| POST | `/v1/images/generations` | 按 `model` 路由到对应上游 |
| POST | `/v1/reload` | 手动重载渠道配置 |
| * | 其他 `/v1/*` | 转发到默认渠道（第一家） |

转发时剥离 hop-by-hop 头（`host`/`connection`/`content-length`/`content-encoding`/`transfer-encoding`），
以免把本地连接的语义泄漏给上游。

---

## 卸载 / 回滚

```powershell
dsh plugin --profile desktop remove dsh-imagegen-relay
```

再重启 DSH。`~/.dsh/imagegen-relay.channels.json` 与 `.status.json` 可一并删除。

---

## 注意

- 这是**本机聚合器**，不是公开代理。它绑 `127.0.0.1`，但**任何能访问本机 8788 端口的进程**
  都能通过它调用你配好的上游（因为你把 key 放在中转里了）。多用户共享的机器上要留意这一点。
- 上游返回的错误会**原样透传**给你，不做改写 —— 排查时看到的报错就是上游给的那条。
