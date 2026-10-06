# 测试套件

> 本文是 [spec-test.md](spec-test.md) 的中文译本。

定义自动化测试套件：覆盖什么、如何运行，以及所需的环境。

## 目标

- 覆盖库的三个部分：`src/util.js` 中的编解码、`Modbus_Server` 和 `Modbus_Client`，以及包对外
  发布的构建产物 `dist/modbus.js`（及 `prebuilds/`）。
- 以 `spec-*` 系列为准进行测试，而不是以当前代码为准。代码尚未满足规格之处（即 `design.zh-cn.md`
  中列出的缺陷），测试仍然陈述规格要求的行为，并标记为已知缺陷（见“已知缺陷”），这样套件能显示
  缺少什么，而不会失败。
- 不需要额外的测试依赖：套件使用 Node.js 内置的运行器（`node:test`、`node:assert/strict`）。
- 除构建产物测试外，直接从 `src/` 导入，因此源码测试无需构建。

## 命令

| 命令                 | 作用                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `pnpm test`          | 先运行 `pnpm build`，再用 `node --test` 运行所有 `test/**/*.test.js`。 |
| `pnpm test:coverage` | 同上，并输出仅限 `src/**` 的内置覆盖率报告。                          |

也可以直接运行 `node --test`；此时若 `dist/modbus.js` 不存在，或比 `src/` 中任一文件旧，构建产物测试
会被跳过。

## 目录布局

| 文件                  | 覆盖内容                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| `test/helpers.js`     | 共享夹具：内存 `vector`、RTU / MBAP 帧构造、伪 TCP 从站、原始 TCP 对端、服务端与客户端的搭建。不是测试文件。 |
| `test/util.test.js`   | 常量、`modbus_crc16`、`parse_modicon_range`、RTU 与 TCP 的请求 / 响应解析器。   |
| `test/client.test.js` | `Modbus_Client` 对接伪 TCP 从站：构造、参数校验、线路上的帧、事务匹配、超时、发送节流、队列溢出、事件、连接与重连、RTU-over-TCP 帧格式。 |
| `test/server.test.js` | `Modbus_Server`：构造、单元 ID、TCP 与 RTU 帧格式下的每个功能码（通过伪套接字 / 伪串口）、异常、事件，以及真实套接字上的 TCP 生命周期。 |
| `test/tcp.test.js`    | 端到端：`Modbus_Client` 与 `Modbus_Server` 在回环地址上通过 Modbus TCP 互测。 |
| `test/serial.test.js` | 通过一对串口的端到端测试：RTU 模式的 `Modbus_Server` 对接原始串口对端，以及 RTU 模式的 `Modbus_Client` 对接 `Modbus_Server`。 |
| `test/bundle.test.js` | 构建产物 `dist/modbus.js`：恰好导出 `Modbus_Client` 和 `Modbus_Server`，`package.json` 的 `exports` 指向它，`serialport` 已被打包且没有对外的导入、没有 `__dirname`，`prebuilds/` 和 `THIRD_PARTY_LICENSES` 已就位，导入它不会加载原生绑定而首次串口 `start()` 会，且打包后的类能完成一次 TCP 往返。 |

## TCP 测试

- 服务端在 `127.0.0.1` 上以端口 `0` 监听，因此每个测试都会得到一个空闲的临时端口，各测试文件可以
  并行运行。
- 仅针对客户端的测试使用一个原始的 `node:net` 服务端充当伪从站，从而可以检查线路上的确切字节，
  并构造格式错误或乱序的应答。
- 仅针对服务端的测试，在不需要网络时通过伪套接字或伪串口把帧送入 `on_data`；在真实传输有意义时
  使用原始的 `node:net` 套接字。
- 串口生命周期测试把 `src/serial.js` 的串口工厂替换为创建伪串口的工厂（`set_serial_port_factory`，
  不属于公共 API），因此不需要串口硬件，也不需要原生绑定。
- 端到端测试把两个类相互连接。

## 串口测试

- 串口测试需要一对像零调制解调器线缆那样相连的串口，例如 com0com 端口对。服务端一侧打开第一个
  端口，对端（原始 `SerialPort` 或 `Modbus_Client`）打开第二个。
- 端口对通过环境变量 `MODBUS_SERIAL_PORTS="<服务端>,<对端>"` 设置；默认为 `COM11,COM12`。
  `MODBUS_SERIAL_PORTS=none` 跳过串口测试。
- 串口测试运行前会做一次预检：打开两个端口，并检查在一个端口写入的字节能否到达另一个端口上已经
  挂起的读操作。任一步失败，串口测试组即被跳过并注明原因，套件其余部分照常运行。

### 串口测试环境

在开发机上（Windows 11，com0com 3.0.0.0 默认参数，`serialport` 10 至 13），预检失败：Node.js
`serialport` 绑定在 com0com 端口上已经发起的读操作，在数据到达时不会完成；数据要等到端口关闭或
同一端口进行写入时才被交付。同一对端口上的 .NET `SerialPort` 双向都正常，说明端口对本身连接无误。
在此问题解决之前（例如通过 com0com 参数或改用其他虚拟串口驱动），该机器上的串口测试组会被跳过。

## 已知缺陷

未实现的规格行为用 `{ todo }` 标记，修复后移除。
