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

### Feature mới (đợt 2)

1. **Conversation history + persistence** — sidebar danh sách hội thoại lưu localStorage, new/switch/rename/delete, auto-title từ message đầu.
2. **System prompt presets** — dropdown preset (General, Code assistant, Translator, Concise, Custom).
3. **Export chat** — tải hội thoại ra Markdown hoặc JSON.
4. **Light/dark theme** — toggle lưu localStorage, CSS variables.
5. **Regenerate** — nút tạo lại response cuối.

### Trạng thái Round 2

- [ ] Plan
- [ ] Server fixes S1–S7
- [ ] Frontend fixes F1–F6
- [ ] Features 1–5
- [ ] Tests + verify server start
- [ ] Commit + self-review

## Review Log

### Vòng 1
- Self-review: `py_compile` pass; 8/8 test case `validate_ollama_url` pass (loopback/local LAN cho phép, metadata/link-local/IPv6 hỏng bị chặn). Phát hiện và sửa 2 lỗi trong chính bản fix: (1) `::1` có `is_reserved=True` trên Python 3.13+ → kiểm tra loopback trước; (2) `urlparse` ném ValueError với IPv6 hỏng → wrap try/except. Client parser đọc frame `t==='error'` mới, bỏ hoàn toàn substring matching.
