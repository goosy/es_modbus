# es-modbus — 规格说明

> 本文是 [spec.md](spec.md) 的中文译本。

规格文档体系的入口。本文定义该库**提供什么**以及**为什么**；实现机制、实现现状和待办事项见
[design.zh-cn.md](./design.zh-cn.md)。

子文档：

- [spec-protocol.zh-cn.md](./spec-protocol.zh-cn.md) — Modbus 帧格式、地址表示法、功能码、CRC。
- [spec-client.zh-cn.md](./spec-client.zh-cn.md) — `Modbus_Client` 的 API、选项、事件、行为约定。
- [spec-server.zh-cn.md](./spec-server.zh-cn.md) — `Modbus_Server` 的 API、`vector` 处理接口、事件。
- [design.zh-cn.md](./design.zh-cn.md) — 如何构建：内部机制、实现现状、已知缺陷与待办事项。

## 目标

为 Node.js 提供一个小巧、依赖很少的 Modbus 实现，在同一个包里同时提供 Modbus 通信的两端：

- `Modbus_Client` — 主站/客户端，发出读写请求，并以 Promise 返回结果。
- `Modbus_Server` — 从站/服务端，接收请求，并通过用户提供的数据访问回调（即 `vector`）作答。

客户端以 `string` 形式使用 Modicon 地址表示法（5 位或 6 位，例如 `"40001,73"`、`"400001,73"`），
或接受结构化的 PDU 地址（功能码、PDU 地址和长度，全部为 `number`）。由类型决定，二者绝不混用。
服务端只使用 PDU 地址。

## 范围

### 范围之内

- 传输方式：Modbus **TCP**、串口上的 Modbus **RTU**，以及 **RTU-over-TCP**
  （在 TCP 套接字上使用 RTU 帧格式）。
- 功能码 `1, 2, 3, 4, 5, 6, 15, 16`（读/写线圈与寄存器，单个与多个）。
- Modbus 异常响应（功能码 + `0x80`，外加一个异常码字节）。
- 多单元服务端：单个服务端实例可承载多个单元 ID（unit ID），并按单元 ID 路由。
- 客户端的事务跟踪、单请求超时、发送节流，以及 TCP 和 RTU-over-TCP 的自动重连。
- 两个类都提供事件发射器，用于线路跟踪（`send` / `receive`）和生命周期通知。

### 范围之外

- 上述列表以外的功能码（诊断 `0x08`、文件记录访问、FIFO、封装传输等）。解析器会拒绝它们。
- ASCII 传输。
- 服务端上的任何持久化数据模型 — 存储完全由调用者的 `vector` 负责。
- 随库提供的自动化测试套件。
- TypeScript 类型（代码用 JSDoc typedef 描述数据形状）。

## 工具与依赖

- **运行时：** 使用 ES 模块的 Node.js（`"type": "module"`）。运行时只使用 Node 内置模块
  （`node:net`、`node:events`），串口/RTU 路径另外使用 `serialport`。
  `serialport` 由用户自行提供：它是可选的 peer 依赖
  （`peerDependencies` + `peerDependenciesMeta.optional`），只用 TCP 的用户无需安装它就能使用本库。
- **包管理器：** pnpm（必须使用 — 见 `AGENTS.md`）。
- **打包器：** Rollup，搭配 `@rollup/plugin-node-resolve`、`@rollup/plugin-commonjs`、
  `@rollup/plugin-json`。

## 构建与目录布局

| 路径                  | 作用                                                             |
| --------------------- | --------------------------------------------------------------- |
| `src/index.js`        | 公共接口：`export { Modbus_Client, Modbus_Server }`。            |
| `src/ModbusClient.js` | 客户端类。                                                       |
| `src/ModbusServer.js` | 服务端类。                                                       |
| `src/util.js`         | 纯协议编解码（帧解析、CRC、地址解析）。无 I/O。                  |
| `rollup.config.js`    | 将 `src/index.js` 打包为 `modbus.js`（ESM）。                    |
| `modbus.js`           | 构建产物，也是包 `exports` 的入口。已被 git 忽略；由 `pnpm build` / `prepare` 生成。 |
| `test/test.js`        | 手动 TCP 冒烟脚本。                                              |

命令：

- `pnpm install`
- `pnpm build` — 在导入 `../modbus.js` 的任何操作之前运行。
- `pnpm test` — 执行 `node ./test/test.js`；绑定 TCP 端口 502 并无限轮询。

## 约定

- 源码仅使用 ESM；标识符使用 `snake_case`，外部接口另有规定的除外（见 `AGENTS.md`）。
- 解析时会校验所支持的功能码和 PDU 长度；格式错误的帧会被丢弃，而不是抛出异常。
- 地址在公共 API 中有两种形式，按 JavaScript 类型区分，定义见 `spec-protocol.zh-cn.md`：
  `string` 是 Modicon 表示法（5 位或 6 位），数组或对象是结构化的 PDU 地址。
