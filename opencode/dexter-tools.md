# Dexter tools

Read at the start of every turn (see dexter-system.md). Reading this file also gives the
dexter_* tools time to connect: `opencode run` starts the MCP server together with the first
model step, so that step does not see them yet.

The `dexter_*` tools come from Dexter's MCP server and read EDINET DB (annual securities reports, TDNet disclosures) and J-Quants (TSE prices).

- dexter_resolve_company: find a company's EDINET code and securities code from a name or code. Use it when a name is ambiguous or another tool says the company was not found.
- dexter_get_financial_statements: multi-year financial time series (revenue, operating income, net income, assets, equity, cash flows, EPS, dividends, and more). Use `years` to keep the window small.
- dexter_get_company_info / dexter_get_key_ratios: latest-year snapshot and key ratios (ROE, margins, PER, equity ratio).
- dexter_get_analysis: financial health score and AI-generated summary from EDINET DB.
- dexter_get_earnings: recent TDNet earnings disclosures (決算短信), only about the last 30 days.
- dexter_get_text_blocks: text of the annual securities report (事業の状況, 事業等のリスク, 経営者による分析, 経営方針).
- dexter_get_shareholders: large shareholding reports (大量保有報告書).
- dexter_screen_companies: screen companies by financial metrics with structured conditions.
- dexter_get_stock_price (when present): daily prices from J-Quants.
- dexter_web_search (when present) and webfetch: news and facts outside the structured data. Use webfetch only for a URL you already have.

Arguments: company tools take `ticker` (e.g. {"ticker": "7203"}); dexter_resolve_company takes `query`.
Large amounts come with a sibling field ending in `_jp` (revenue_jp: "50兆6,850億円").
