# Ollama Chat Web

Ứng dụng chat web local kết nối tới Ollama, hiển thị streaming nhanh như terminal.

## Yêu cầu
- Python 3 (không cần cài thêm dependencies)
- Ollama đang chạy (`ollama serve`)

## Chạy
```bash
cd ollama-chat
python3 server.py
```
Mở trình duyệt: http://localhost:8080

## Tính năng
- ⚡ Streaming real-time - text hiển thị ngay khi model sinh ra từng token (nhanh như terminal)
- 📊 Token count / cost estimator - hiển thị số token tiêu thụ mỗi response + tổng phiên, kèm ước tính chi phí API (live cập nhật theo từng token khi streaming)
- ⏱️ Thời gian response - hiện latency dạng `"x.xs, y tokens/s"` dưới mỗi response (live hiển thị khi đang stream kèm dấu `…`)
- 💬 Giao diện chat bubble - tin nhắn user căn phải, response assistant căn trái
- 🎨 Giao diện terminal-style (dark theme, monospace font, cursor nhấp nháy)
- ⚙️ Config: chọn model, Ollama URL, temperature, system prompt
- 🛑 Nút Dừng để hủy response đang chạy
- 💬 Giữ lịch sử hội thoại (multi-turn context)
- 🏷️ Hiển thị khả năng model khi chọn model: Vision / Tools / Thinking / Audio (badge xanh = hỗ trợ, mờ = không)
- 🖼️ Upload ảnh: bấm nút 📎 hoặc drag/drop ảnh vào cửa sổ chat (chỉ active khi model hỗ trợ vision)
- 🎤 Ghi âm giọng nói gửi kèm tin nhắn (chỉ active khi model hỗ trợ audio)
- 🧠 Hiển thị cả phần thinking và answer — phần thinking mở mặc định, click `[− thinking]` để thu gọn thành `[+ thinking]`
- 🧷 Nút `＋` cạnh `user@local` mở dropdown chứa `📎 Ảnh` và `🎤 Ghi âm` (ẩn/disable theo khả năng model)
- ⌨️ Enter để gửi, Shift+Enter để xuống dòng

### Mới trong Round 2
- 🗂️ **Lịch sử hội thoại** — sidebar danh sách hội thoại lưu localStorage: tạo mới / chuyển / đổi tên / xóa, tự đặt tiêu đề từ tin nhắn đầu
- 🧩 **System prompt presets** — General / Code assistant / Translator / Concise / Custom
- 📤 **Export chat** — tải hội thoại hiện tại ra Markdown hoặc JSON
- 🌗 **Theme sáng/tối** — toggle trên topbar, lưu localStorage, CSS variables (kèm màu syntax theo theme)
- ↻ **Regenerate** — tạo lại response cuối cùng
- 🔒 Markdown render qua DOMPurify (sanitize output model), syntax highlight chạy đúng với hljs hiện đại
- 📱 Responsive: sidebar thành overlay trên mobile; cải thiện spacing/typography

> **Ghi chú cost estimator:** Ollama local miễn phí. Số tiền hiển thị là placeholder theo mức giá API điển hình ($0.10/1M input, $0.40/1M output) — để tham khảo, có thể chỉnh hằng số `COST_INPUT_PER_1M` / `COST_OUTPUT_PER_1M` trong `static/app.js`.

### Mới trong Round 3
- 📦 **Vendor libs cục bộ** — marked/DOMPurify/highlight.js + themes tải về `static/vendor/` (pin version), không còn script từ CDN; CSP siết còn `script-src 'self'`
- 📊 **Thống kê dùng bền vững** — tổng msgs + tokens (in/out) lưu localStorage, sống qua reload; double-click vào label stats trên topbar để reset
- 🐛 Fix: biến `sessionStats` chưa khai báo → ReferenceError sau mỗi response có stats

## Cấu trúc
```
ollama-chat/
├── server.py              # Entry point HTTP server
├── server_lib/
│   ├── __init__.py
│   ├── config.py          # Cấu hình mặc định
│   ├── handler.py         # HTTP route handlers
│   └── ollama.py          # Proxy /api/chat tới Ollama, streaming NDJSON
└── static/
    ├── index.html         # Giao diện web
    ├── app.js             # Logic frontend
    ├── style.css          # Style
    └── vendor/            # Thư viện JS/CSS bên thứ 3 (vendor cục bộ, pin version)
        ├── marked.min.js            # marked 12.0.2 (markdown parser)
        ├── purify.min.js            # DOMPurify 3.0.9 (sanitize HTML)
        ├── highlight.min.js         # highlight.js 11.9.0 (syntax highlight)
        ├── hljs-github-dark.min.css # hljs theme cho dark mode
        └── hljs-github.min.css      # hljs theme cho light mode
```

## Thư viện vendor (static/vendor/)

Toàn bộ JS/CSS bên thứ ba được **serve cục bộ** từ `static/vendor/` — không tải
từ CDN nào. Nhờ đó CSP chỉ cần `script-src 'self'; style-src 'self'`, một origin
bên ngoài bị compromise không thể chạy script trên trang.

### Cập nhật thư viện vendor

Khi cần nâng cấp (ví dụ vá bảo mật):

1. Tải đúng file từ CDN và **ghi đè** file tương ứng trong `static/vendor/`,
   giữ nguyên tên file (hoặc đổi tên + sửa `static/index.html`):

   ```bash
   curl -fsSL -o static/vendor/marked.min.js \
     "https://cdn.jsdelivr.net/npm/marked@<version>/marked.min.js"
   curl -fsSL -o static/vendor/purify.min.js \
     "https://cdn.jsdelivr.net/npm/dompurify@<version>/dist/purify.min.js"
   curl -fsSL -o static/vendor/highlight.min.js \
     "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/<version>/highlight.min.js"
   # themes (github + github-dark), cùng version với highlight.min.js
   curl -fsSL -o static/vendor/hljs-github.min.css \
     "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/<version>/styles/github.min.css"
   curl -fsSL -o static/vendor/hljs-github-dark.min.css \
     "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/<version>/styles/github-dark.min.css"
   ```

2. Kiểm tra file tải về parse được: `node --check static/vendor/*.js`
3. `marked` v5+ đã bỏ option `highlight` — app highlight bằng
   `hljs.highlightElement` sau khi parse (xem `postProcessContent` trong `app.js`);
   nếu nâng hljs major, kiểm tra lại API này.
4. Mở app, kiểm tra markdown + code highlight vẫn render (thử một block ```python).

> Lưu ý: nếu thư viện mới cần thêm loại tài nguyên (font, worker...), phải cập nhật
> CSP trong `server_lib/handler.py` (`_security_headers`) một cách tối thiểu —
> đừng mở lại origin CDN.

## Cấu hình mặc định (trong `server_lib/config.py`)

```python
DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "gemma4:12b-mlx"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."
```

### Giải thích từng biến

| Biến | Giá trị mặc định | Ý nghĩa |
|------|-----------------|---------|
| `DEFAULT_OLLAMA_URL` | `http://localhost:11434` | Địa chỉ API của Ollama server. Mặc định Ollama chạy local trên port 11434. Nếu Ollama chạy trên máy khác hoặc qua Docker, đổi thành URL tương ứng (ví dụ: `http://192.168.1.10:11434`) |
| `DEFAULT_MODEL` | `gemma4:12b-mlx` | Model mặc định được chọn khi mở ứng dụng. Xem danh sách model đã pull bằng lệnh `ollama list`. Pull model mới: `ollama pull <tên-model>` |
| `DEFAULT_TEMPERATURE` | `0.7` | Mức độ ngẫu nhiên/sáng tạo của model khi sinh câu trả lời (0.0 - 2.0). **Thấp (0.0-0.3)**: chính xác, nhất quán, phù hợp code/toán. **Trung bình (0.4-0.7)**: cân bằng, tự nhiên, phù hợp chat thông thường. **Cao (0.8-1.5)**: sáng tạo, đa dạng, phù hợp viết truyện/brainstorm |
| `DEFAULT_SYSTEM_PROMPT` | `You are a helpful assistant.` | System prompt mặc định định hướng hành vi của model. Có thể thay đổi trên giao diện qua nút ⚙ (Settings) |

### Cách thay đổi cấu hình

**Cách 1 - Sửa trực tiếp trong `server_lib/config.py`**: Mở file, sửa giá trị các biến mặc định, lưu và khởi động lại server.

**Cách 2 - Thay đổi trên giao diện web** (không cần sửa code):
- **Model**: Chọn từ dropdown trên thanh công cụ
- **Ollama URL**: Nhập URL vào ô text trên thanh công cụ
- **Temp**: Nhập giá trị temperature (0-2) vào ô số trên thanh công cụ
- **System Prompt**: Bấm nút ⚙ để mở panel settings, sửa system prompt

> **Lưu ý**: Thay đổi trên giao diện chỉ có hiệu lực trong phiên hiện tại. Khi reload trang, các giá trị sẽ trở về mặc định trong `server_lib/config.py`.

## Khả năng model (capabilities)

Khi chọn model trong dropdown, ứng dụng gọi Ollama `/api/show` và hiển thị bar khả năng:

| Khả năng | Ý nghĩa | UI tương ứng |
|----------|---------|--------------|
| 👁 Vision | Model nhận ảnh đầu vào | Nút 📎 đính ảnh active (click hoặc drag/drop) |
| 🔧 Tools | Model gọi function/tool calls | Badge hiển thị |
| 🧠 Thinking | Model sinh reasoning/thinking | Badge hiển thị + phần thinking trong response |
| 🎤 Audio | Model nhận audio đầu vào | Nút 🎤 ghi âm active, gửi kèm base64 |

Detection: `vision`/`tools` lấy trực tiếp từ `capabilities` của `/api/show`. `thinking`/`audio` được suy ra thêm từ model family (qwen3, deepseek-r1, qwen2.5-omni, ...) vì Ollama không liệt kê chúng trong capabilities.

> **Lưu ý:** Một số model multimodal unified (ví dụ `gemma4` family) có thể xử lý ảnh dù API không liệt kê `vision` trong capabilities — ứng dụng hiển thị theo dữ liệu API trả về.

## Model hỗ trợ

### Model hiện tại: `gemma4:12b-mlx`
- **Capabilities (API)**: `completion`, `tools`, `thinking`
- **Vision (image)**: ✅ **Có hỗ trợ** (đã test thực tế)
- **Context length**: 262,144 tokens
- **Parameter size**: 12.4B
- **Quantization**: nvfp4

> **Vì sao API không liệt kê `vision` nhưng model vẫn xử lý ảnh?**
> Ollama UI (`ollama list`) hiển thị "Text, Image" dựa trên dữ liệu metadata của model blob,
> trong khi `/api/show` trả về `capabilities` array chưa đầy đủ cho kiến trúc `gemma4_unified`
> (multimodal unified). Test thực tế gửi ảnh PNG (4x4 pixel đỏ) cho thấy model nhận diện
> đúng màu sắc kèm suy nghĩ chi tiết — **model thực sự hỗ trợ image**.
> 
> **⚠️ Lưu ý:** Kể cả khi API không liệt kê `vision`, bạn vẫn có thể gửi ảnh qua
> `images: [base64_string]` trong payload của `/api/chat`. Ollama xử lý ảnh ở backend
> trước khi đưa vào model.

### Model có vision (chat với ảnh)
Model hiện tại **đã hỗ trợ** ảnh. Ngoài ra bạn có thể pull thêm các model vision khác:
```bash
ollama pull llama3.2-vision   # 11B
ollama pull llava             # 7B/13B
ollama pull gemma3:12b        # 12B (có vision)
```

## API Endpoints

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/` | GET | Trang chat chính |
| `/static/*` | GET | File tĩnh (CSS/JS) |
| `/api/models` | GET | Lấy danh sách model từ Ollama (`?url=<ollama_url>`) |
| `/api/model-info` | POST | Lấy thông tin khả năng model: `{"name", "family", "capabilities", "supports": {"vision", "tools", "thinking", "audio"}}` |
| `/api/chat` | POST | Gửi tin nhắn chat, trả về stream NDJSON gồm `{"t":"think","d":"..."}` (phần suy nghĩ), `{"t":"content","d":"..."}` (câu trả lời), `{"t":"progress",...}` (token/latency live giữa chừng) và `{"t":"stats",...}` (thống kê cuối: `prompt_tokens`, `output_tokens`, `eval_duration`, `total_duration`, `eval_count`) |
