# Plan — app-ollama-local-chat

> Web UI chat với Ollama local (Python stdlib server, không dependency ngoài).

## Kết quả Review (audit đợt 1)

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| 1 | CRITICAL | handler.py:34-36 | `_read_body` đọc Content-Length không giới hạn → DoS (client gửi 10GB header là 10GB RAM) | Cap 25MB, trả 413 |
| 2 | MAJOR | config.py:33+ | SSRF: chỉ check hostname đen tĩnh — DNS-rebind (hostname benign trỏ 169.254.169.254) qua được | Resolve DNS, check từng IP kết quả; giữ loopback cho phép (mặc định Ollama chạy localhost) |
| 3 | MAJOR | handler.py:96-99 | Không validate `model`/`temperature`/`messages` → payload rác đẩy thẳng vào Ollama, temperature bool/âm/nhân bản lỗi khó debug | Validate type + range 0–2 + shape từng message |
| 4 | MAJOR | handler.py:127 | Lỗi stream ghi `[ERROR] {msg}` dạng sentinel text — model có thể tự sinh đúng chuỗi đó → nhận diện sai; lẫn vào nội dung chat | NDJSON frame `{"t":"error","d":...}` + cập nhật parser client |
| 5 | MAJOR | server.py:23 | `server.shutdown()` gọi từ cùng thread `serve_forever` → deadlock khi Ctrl+C | `server_close()` trong `finally` |
| 6 | MAJOR | server.py:14 | Thread handler không daemon → process không thoát nếu stream treo | `daemon_threads = True` |
| 7 | MAJOR | handler.py:17-18 | `log_message` nuốt SẠCH mọi log kể cả 5xx → không debug được sự cố | `log_request` chỉ log ≥500 |
| 8 | MINOR | ollama.py:114-121 | 2 progress frame "0 tokens" rác cho mỗi token content | Chỉ gửi khi có số liệu |
| 9 | MINOR | static/app.js:342 | `?url=` gửi khi ollamaUrl() rỗng → server nhận `url=''` | Chỉ append param khi có giá trị |
| 10 | MINOR | static/app.js:550 | Clipboard không `.catch` → unhandled rejection trên http (non-secure) | Thêm catch + feedback |
| 11 | MINOR | handler.py:39-43 | Static path chỉ normpath — symlink escape không chặn được | realpath check |
| 12 | MINOR | handler.py:112 | Content-Type stream là `text/plain` dù body là NDJSON | `application/x-ndjson` |
| 13 | MINOR | config.py | Metadata `100.100.100.200` chỉ nằm trong hostname blacklist, IP literal qua được (không phải link-local) | Check trong `_check_ip` |

## Quyết định thiết kế

- **Không blanket-block private/loopback**: đây là tool local chạy trên máy user, mặc định kết nối Ollama tại `localhost:11434`. Chặn private IP làm hỏng use-case chính. Bù lại: DNS-resolve + check IP thật, metadata endpoints chặn cứng, và `ALLOWED_OLLAMA_HOSTS` whitelist sẵn có cho môi trường chia sẻ.

## Trạng thái

- [x] Plan
- [x] Fix #1–#13
- [x] Commit + self-review

## Round 2 (2026-10-29)

### Kết quả deep review (đợt 2)

Server:

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| S1 | MAJOR | handler.py `_read_json` | Body quá lớn NÀY JSON hỏng đều raise `ValueError` → JSON hỏng bị trả 413 thay vì 400 | Tách sentinel exception riêng cho body-too-large |
| S2 | MAJOR | ollama.py `fetch_models` | Ollama chết trả `[]` — client không phân biệt "không có model" vs "không kết nối được"; trả về `{models, error}` | Đổi shape response, UI hiển thị lỗi thật |
| S3 | MAJOR | ollama.py `_request` | Timeout 300s cho GET `/api/tags` — UI treo gần 5 phút khi Ollama chết | Timeout ngắn (10s) cho listing, giữ 600s cho stream |
| S4 | MINOR | handler.py `_read_body` | `Transfer-Encoding: chunked` (không có Content-Length) → body không đọc, rác vào request kế tiếp trên keep-alive | Từ chối 411 khi có chunked không đọc được |
| S5 | MINOR | handler.py | Thiếu security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) | Thêm vào mọi response |
| S6 | MINOR | handler.py | `do_HEAD` không có → 501 cho HEAD / | Thêm do_HEAD trả header không body |
| S7 | MINOR | handler.py `_handle_chat` | Sau khi client ngắt kết nối, server vẫn tiếp tục đọc hết stream từ Ollama | Ném ConnectionError từ on_chunk và ngừng đọc upstream |

Frontend:

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| F1 | MAJOR | app.js `renderMarkdown` | marked không sanitize → XSS từ output model (local app nhưng vẫn harden) | DOMPurify sanitize sau parse |
| F2 | MAJOR | app.js `renderMarkdown` | Option `highlight` đã bị loại khỏi marked v5+ → syntax highlight âm thầm không chạy | Dùng `hljs.highlightElement` sau parse |
| F3 | MAJOR | app.js `refreshMarkdownRendering` | Lấy raw text từ `textContent` sau khi đã render HTML → toggle Md làm hỏng nội dung | Lưu raw text trong `data-raw` |
| F4 | MINOR | app.js | Auto-scroll luôn ép xuống cuối khi streaming → user đọc phần trên bị giật màn hình | Scroll-lock: chỉ tự cuộn khi đang ở gần đáy |
| F5 | MINOR | app.js | Code render meta bị trùng 2 nơi (`renderMeta` + block stats) | Dedupe qua 1 hàm |
| F6 | MINOR | style.css | Không responsive mobile; spacing/typography thiếu hệ thống | Design tokens, media queries, theme sáng/tối |

Phát hiện thêm trong quá trình implement (đợt 2):

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| X1 | MAJOR | handler `on_chunk` | `socket.timeout` khi client nhận chậm không bị coi là ngắt → handler thread treo đến 600s | Ghi fail → raise `ConnectionError`, ngừng đọc upstream |
| X2 | MAJOR | app.js | Switch conversation giữa lúc streaming → reply một phần rơi vào conversation SAI (closure đọc `messages` mới) | Capture `hist` đầu hàm; push vào đúng array; tìm conv theo reference khi save |
| X3 | MAJOR | app.js | `messages` gửi server chứa `{dataUrl}` (dùng cho display/persist) thay vì base64 → Ollama nhận payload sai | Map `stripBase64Prefix(dataUrl)` lúc build payload |
| X4 | MINOR | handler.py | Không có CSP → thiếu một lớp bảo vệ nếu CDN bị compromise | CSP chặt: script/style chỉ self + 2 CDN, `frame-ancestors 'none'` |
| X5 | MINOR | handler.py | Abort chỉ catch BrokenPipe/Reset — half-open connection treo thread | Gộp thành `except ConnectionError` |
| X6 | MINOR | app.js | Abort giữa chừng làm mất text đã stream (không push vào history) | Lưu partial text + `_[Stopped]_` như một assistant turn |
| X7 | MINOR | ollama.py `fetch_model_info` | 404 (model không tồn tại) và 502 (không kết nối được) bị gộp → client không phân biệt | Trả `(info, error, upstream_status)`, handler map 404/502 |

### Feature mới (đợt 2)

1. **Conversation history + persistence** — sidebar danh sách hội thoại lưu localStorage, new/switch/rename/delete, auto-title từ message đầu.
2. **System prompt presets** — dropdown preset (General, Code assistant, Translator, Concise, Custom).
3. **Export chat** — tải hội thoại ra Markdown hoặc JSON.
4. **Light/dark theme** — toggle lưu localStorage, CSS variables.
5. **Regenerate** — nút tạo lại response cuối.

### Trạng thái Round 2

- [x] Plan
- [x] Server fixes S1–S7 (+ X1, X4, X5, X7)
- [x] Frontend fixes F1–F6 (+ X2, X3, X6)
- [x] Features 1–5 (history, presets, export, theme, regenerate)
- [x] Tests + verify server start: 22/22 unit tests pass; e2e với mock Ollama
      (stream NDJSON content/stats frame, /api/models, /api/model-info, 411/413/400/502 paths)
- [x] Commit + self-review

### Verify

- `python3 -m unittest discover -s tests` → 22 OK (19 cũ + 3 mới cho fetch_model_info)
- `node --check static/app.js` → OK
- Khởi động `python3 server.py` + mock Ollama:
  `/api/models` trả list; `/api/chat` stream `{"t":"content"}` ×4 + `{"t":"stats"}`;
  `/api/model-info` trả capabilities; body lỗi → 400, chunked → 411, body lớn → 413.
- Không có test/lint config khác trong repo (không package.json, không ruff/flake8).

## Round 3 (2026-10-29)

### Scope (Round-2 remaining risks)

1. Vendor CDN libs → local, tighten CSP
2. Session stats persistence (localStorage)
3. Fix bugs found

### Kết quả

**B0 (bug mới phát hiện) | MAJOR | app.js** — `sessionStats` được dùng ở
`updateSessionStats` + luồng chat nhưng **không hề khai báo** (`let/const` nào
cả). Mỗi response hoàn thành có stats → `ReferenceError: sessionStats is not
defined` trong khối try → bắt ở catch → hiển thị lỗi giả "sessionStats is not
defined" dưới bubble thay vì meta stats. Round 2 chưa từng chạy được tính năng
token tổng. Fix: gộp vào mục stats persistence bên dưới (khai báo + init).

**V1 — Vendor libs cục bộ + CSP siết:**

- Tải pin version vào `static/vendor/` (repo dùng `static/`, không `public/`):
  `marked.min.js` 12.0.2, `purify.min.js` 3.0.9, `highlight.min.js` 11.9.0,
  `hljs-github-dark.min.css` + `hljs-github.min.css` 11.9.0.
  Trước đây marked dùng đường dẫn *unpinned* (`marked/marked.min.js` — floating
  latest), giờ pin đúng version.
- `index.html`: 2 hljs theme `<link id="hljsDark"|"hljsLight">`, toggle
  `disabled` trong `applyTheme` để code highlight theo light/dark.
- `handler.py` CSP: bỏ hẳn 2 origin CDN → `script-src 'self'; style-src 'self'
  'unsafe-inline'`; giữ `img-src data: blob:` cho preview. Không origin ngoài.

**V2 — Session stats persistence:**

- Khai báo `sessionStats = {promptTokens, outputTokens, messages}`; lưu
  localStorage key `oc:stats` (`loadSessionStats`/`persistSessionStats`);
  load + render ngay khi init → sống qua reload.
- Header hiển thị `N msgs · total tokens (in / out) · est $...`; double-click
  vào label để reset (persist luôn giá trị 0).
- Đếm mỗi exchange hoàn thành (kể cả response không có stats frame); abort
  giữa chừng không đếm (chưa hoàn thành).

### Verify (Round 3)

- `python3 -m unittest discover -s tests` → 22/22 OK
- `node --check` trên `static/app.js` + cả 3 vendor .js → OK
- Server smoke test (Ollama KHÔNG chạy):
  - `GET /` → 200; CSP = `default-src 'self'; script-src 'self'; style-src
    'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:;
    connect-src 'self'; frame-ancestors 'none'` — không còn origin CDN
  - 7 asset (`app.js`, `style.css`, 3 vendor js, 2 hljs css) → tất cả 200
  - `index.html` chỉ tham chiếu `/static/...`, không có URL ngoài
  - `/api/models` → 200 + `error` field (graceful); `/api/chat` → NDJSON
    `{"t":"error"}`; bad JSON 400, chunked 411, body 26MB 413, traversal 403
- DOM-level check (jsdom, chạy ngoài repo): marked parse → h1 + `language-python`
  class; DOMPurify strip `<script>` + `onerror`; hljs `highlightElement` highlight
  được block python → ALL PASS
- Lưu ý: `hljs.version` không tồn tại trên build UMD 11.9.0 nhưng
  `hljs.highlight`/`highlightElement` hoạt động đúng (API app dùng)

### Round 4 — còn lại (rủi ro tồn đọng)

1. **Không có e2e tự động cho frontend** — render markdown/stats chỉ verify
   thủ công + jsdom ad-hoc; có thể thêm harness jsdom/nhựa test cho `app.js`.
2. **Stats per-conversation** — hiện chỉ có global cumulative; tách theo
   conversation (reset khi tạo chat mới?) nếu cần.
3. **marked 12.0.2 → kiểm tra nâng cấp lớn tiếp theo** (API `marked.parse`
   ổn định nhưng cần re-verify khi lên major mới).
4. **Config server-side cho vendor path/versions** — version nằm trong tên file
   + README; nếu thêm lib, nhớ cập nhật cả CSP review.
5. **HTTP/1.0 server** — không keep-alive/compression; OK cho local, cân nhắc
   nếu dùng qua network.

## Review Log

### Vòng 1
- Self-review: `py_compile` pass; 8/8 test case `validate_ollama_url` pass (loopback/local LAN cho phép, metadata/link-local/IPv6 hỏng bị chặn). Phát hiện và sửa 2 lỗi trong chính bản fix: (1) `::1` có `is_reserved=True` trên Python 3.13+ → kiểm tra loopback trước; (2) `urlparse` ném ValueError với IPv6 hỏng → wrap try/except. Client parser đọc frame `t==='error'` mới, bỏ hoàn toàn substring matching.

### Vòng 2
- Note: session trước bị interrupt để lại WIP chưa commit (handler/ollama/index.html) — đã review, hoàn thiện (app.js + style.css viết lại toàn bộ để khớp layout mới), commit trong Round 2.
- Self-review sau commit: sửa X2 (race switch-conv giữa stream), X3 (dataUrl vs b64 trong payload), dataset.raw cho abort partial. E2e với mock Ollama OK.
