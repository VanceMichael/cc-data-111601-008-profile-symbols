# 来源约定

## 产品交换范围

pprof profile.proto 支持 string_table、sample_type、sample、mapping、location、function 常用字段；varint、packed 数值和 unknown fields 按 protobuf wire type 保留/跳过。/catalog 给出 buildId 到符号服务的路由，GET 符号服务接受 addresses=以逗号分隔的十进制对象地址，每次最多 2 个不同地址；返回 addresses 字典和 missing。对象地址为 location.address - mapping.memory_start + mapping.file_offset，映射区间左闭右开。buildId 对应 string_table 项，不能按文件名合并。地址和样本整数允许超过 JS 安全整数，应采用精确表示。lines 按服务返回内联链顺序保留。符号补领不能改变 sample.value、label 和采样次数，不做火焰图或热点分析。

## 当前来源路由

- `/primary`：application/octet-stream
- `/profiles/other`：application/octet-stream
- `/symbols/build-A`：application/json
- `/symbols/build-B`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://github.com/google/pprof/blob/main/proto/profile.proto

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
