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

## Review Log

### Vòng 1
- Self-review: `py_compile` pass; 8/8 test case `validate_ollama_url` pass (loopback/local LAN cho phép, metadata/link-local/IPv6 hỏng bị chặn). Phát hiện và sửa 2 lỗi trong chính bản fix: (1) `::1` có `is_reserved=True` trên Python 3.13+ → kiểm tra loopback trước; (2) `urlparse` ném ValueError với IPv6 hỏng → wrap try/except. Client parser đọc frame `t==='error'` mới, bỏ hoàn toàn substring matching.
