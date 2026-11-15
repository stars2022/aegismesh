"""Shared component contract for every digital-human UI generation path."""
DYNAMIC_UI_CONTRACT = (
    'ui_blocks 只允许以下结构，严格使用这些字段名。每个分项必须带实际内容，不得只返回候选名称或空标签。未知内容请说明未提供，禁止补造事实。\n'
    'kpi_grid: {"type":"kpi_grid","title":"指标","items":[{"label":"名称","value":"数值","delta":"变化","trend":"up|down|flat"}]}\n'
    'bar_chart: {"type":"bar_chart","title":"对比","items":[{"label":"名称","value":123,"display":"123亿"}]}\n'
    'line_chart: {"type":"line_chart","title":"趋势","items":[{"label":"Q1","value":123,"display":"123亿"}]}\n'
    'pie_chart: {"type":"pie_chart","title":"占比","items":[{"label":"分部","value":60,"display":"60%"}]}\n'
    'quiz: {"type":"quiz","title":"互动问答","questions":[{"question":"题干","options":[{"key":"A","label":"选项","correct":true,"explanation":"解析"}]}]}（决策选择可省略 correct）\n'
    'table: {"type":"table","title":"明细","columns":["列名"],"rows":[["单元格内容"]]}，rows 必须为二维数组。\n'
    'cards: {"type":"cards","title":"重点","items":[{"title":"名称","subtitle":"副标题","body":"具体说明","badge":"状态","url":"https://来源地址"}]}\n'
    'actions: {"type":"actions","items":[{"label":"追问","prompt":"发送的问题"}]}\n'
    '界面只呈现用户当前需要的关键信息，最多3个模块。先给结论，再给最多3个候选的简洁对比和必要的待确认事项。'
    '涉及数据趋势/对比/占比时优先使用 line_chart、bar_chart 或 pie_chart；需要用户答题或互动选择时使用 quiz；'
    '候选比较优先使用一张table，或cards并排呈现；禁止tabs、分页、轮播，禁止只展示名称让用户逐个点击。'
    '每个候选正文最多两句、表格最多4列，避免同一内容在不同模块重复。不要生成“已整理完成”等过程通知或空占位卡片。'
    '只组合与已有事实有关的模块。纯语音闲聊使用空数组。'
)
