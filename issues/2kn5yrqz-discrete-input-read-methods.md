---
id: 2kn5yrqz
opened: 2026-10-24T03:14:23.284Z
closed:
title: vector 增加离散输入的读方法（单点与成批）
status: open        # open | accepted | fixed | rejected | wontfix
fixed_in: []        # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title: 问题描述
proposal_title: 解决提案
decision_title: 裁定
---

## 问题描述

vector 接口没有离散输入（1xxxx）的访问器：FC 1（读线圈）和 FC 2（读离散输入）都调用 `get_coil`，vector 收不到功能码，分不清这次读的是哪张表。

寄存器一侧有 `get_holding_register`（FC 3）和 `get_input_register`（FC 4）两个读方法，位一侧只有一个，读接口不对称。

影响：线圈和离散输入不能使用不同的数据。例如一个从站有可写的线圈表和只读的输入表，同一个地址在两张表里应是两个点，现在 FC 1 和 FC 2 读到的必然是同一个值。

## 解决提案

vector 增加可选的离散输入读方法，FC 2 使用：

| 方法 | 用于 | 返回 |
| --- | --- | --- |
| `get_discrete_input(addr, unit_id)` | FC 2 | 真值 = 位已置位 |
| `get_discrete_inputs(addr, quantity, unit_id)` | FC 2 | 长度为 `quantity` 的数组，元素按真值取位 |

- FC 2 的选择顺序：vector 提供了离散输入方法时，有 `get_discrete_inputs` 则一次请求调用一次，否则逐点调用 `get_discrete_input`；两个都没有时，FC 2 按 FC 1 处理（`get_coils`，否则逐点 `get_coil`）。不区分两张表的 vector 因此照常工作。
- FC 1 只用线圈的方法，不受离散输入方法影响。
- 成批方法的规则与 issue#yjaww5qx 相同：按功能码选择，与数量无关；每次请求时判断；只对通过 `check_request` 的请求调用；抛出异常时答 0x04 并发出 `vector_error`；返回值长度不等于 `quantity` 时按 vector 错误处理。
- 成批方法依赖 issue#yjaww5qx 的成批读机制，两者宜一起实现。

## 裁定
