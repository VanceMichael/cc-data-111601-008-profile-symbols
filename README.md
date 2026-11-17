# profile-symbols

性能剖面中按构建身份补领符号资料相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- pprof protobuf 原样接收：string_table、sample_type、sample、mapping、location、function 常用字段结构化解释，64 位整数（地址、样本值、标签数值）全程 BigInt 精确表示，超过 JS 安全整数不丢精度。
- 按合作方符号服务补领位置与内联调用链：以 mapping 的 buildId 为构建身份经 `/catalog` 路由，绝不按文件名或加载地址合并；对象地址按 `location.address - mapping.memory_start + mapping.file_offset` 计算，映射区间左闭右开，区间外地址不发请求。
- 批量与部分覆盖：符号请求每批不超过 2 个不同地址，同一 buildId 下相同对象地址去重共享答案；服务只覆盖部分地址时，其余位置保持未解释并记录可定位原因（服务声明 missing、响应未覆盖、无路由、请求失败、buildId 不匹配等）。
- 只解释、不汇总结论：补符号不合并样本、不改 `sample.value`、标签、取值类型和采样次数，不做火焰图或热点分析；服务在每轮补领前后校验样本表指纹一致。
- 重补不打散已有内联层次：已解释位置不重复请求，后续轮次只追加 pass 记录，内联链按服务返回顺序原样保留。

`src/reader.mjs` 提供底层 protobuf 读取契约；`src/profile.mjs` 负责结构化解码、持久化还原与对象地址计算；`src/symbolizer.mjs` 是不绑定 HTTP 的符号补领领域引擎；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和独立解释文档。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。登记成功后自动按 catalog 执行一轮符号补领，响应含 `symbolization.summary`（resolved/unresolved 计数及按原因分组）。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id，已存在解释时不重复外呼。
- GET /objects/{digest}：读取已保存的原始字节（永不被补领过程改写）。
- GET /interpretations/{id}：读取解释文档，含完整 profile 表副本、逐位置状态（resolved/unresolved、对象地址、buildId、原因、内联链）及各轮 pass 的请求与响应摘要。
- POST /interpretations/{id}/symbolize：对已登记资料再执行一轮补领；只追加 pass，已解释位置不重发请求、内联层次不变。

这六项是兼容接口，GET 请求不产生写操作。收件记录当前只包含单件 raw 对象与解释状态，不代表关联资料已完整；未解释位置始终显式列出原因，不把未知转换成已确认的空结果。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，符号补领（批量上限、部分覆盖、重定位、buildId 区分、重补保留内联、样本不变性、大整数精度）在 test/symbolizer.test.mjs，HTTP 端到端与 catalog 故障降级在 test/integration.test.mjs 和 test/catalog-failure.test.mjs。`scripts/make-fixtures.mjs` 用最小 protobuf 编码器确定性生成多映射多位置夹具 `fixtures/resource-04.bin`。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t profile-symbols:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
