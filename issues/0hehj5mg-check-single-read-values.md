---
id: 0hehj5mg
opened: 2026-10-24T04:06:31.416Z
closed: 2026-10-24T04:22:58.090Z
title: 单点读寄存器的返回值未经检查，越界值可使服务端崩溃
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: []        # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title: 问题描述
proposal_title: 解决提案
decision_title: 裁定
---

## 问题描述

spec 约定 `get_holding_register` / `get_input_register` 返回 `0..65535` 的整数，服务端却不检查返回值，直接交给 `buffer.writeUInt16BE` 写入响应（`handle_read_registers`）。实测 FC 3 单点读：

| 返回值 | 结果 |
| --- | --- |
| `70000`、`-1` | 抛出 `RangeError`（`ERR_OUT_OF_RANGE`） |
| `1.5` | 截断为 1 |
| `'7'` | 转换为 7 |
| `undefined`、`null`、`NaN` | 变成 0 |

影响：

- 越界值使服务端崩溃。`RangeError` 不是 `Vector_Error`，`serve()` 不捕获，它从 `on_data` 传出到 socket / 串口的 `data` 事件监听器，成为未捕获异常，进程退出。这违背 spec 中"有缺陷的 `vector` 不会让服务端崩溃"的承诺。
- 不合契约的值被悄悄转换，主站收到看似正常的数据，vector 的缺陷被掩盖。

线圈不受影响：`get_coil` 的返回值按真值取位，任何值都有意义。

issue#yjaww5qx 的成批读方法也要检查返回值，单点读应与之采用同一条规则。

## 解决提案

单点读寄存器与成批读使用同一条检查规则：返回值不是 `0..65535` 的整数时，按抛出异常的 `vector` 处理，以 `TypeError` 发出 `vector_error`，应答异常 `0x04`。实现上合用 `is_register_value`。

- `undefined` 也算错误。依赖"未映射的地址返回 `undefined`、读出 0"的 vector 会改为得到 `0x04`，这是行为变化；0.3.0 是事实上的首个正式版本，可以接受，CHANGELOG 中注明。
- 只把越界值改为 `0x04`、其余仍悄悄转换：不采纳，规则不一致，且仍掩盖 vector 的缺陷。

## 裁定

fixed。按提案实现：寄存器读访问器的返回值不是 `0..65535` 的整数时，以 `TypeError` 发出 `vector_error` 并应答 `0x04`，`undefined` 也在内。越界值不再使服务端崩溃，不合契约的值不再被悄悄转换。
