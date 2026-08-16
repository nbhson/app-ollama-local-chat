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
- 🎨 Giao diện terminal-style (dark theme, monospace font, cursor nhấp nháy)
- ⚙️ Config: chọn model, Ollama URL, temperature, system prompt
- 🛑 Nút Dừng để hủy response đang chạy
- 💬 Giữ lịch sử hội thoại (multi-turn context)
- ⌨️ Enter để gửi, Shift+Enter để xuống dòng

## Cấu trúc
```
ollama-chat/
├── server.py          # Python HTTP server (proxy tới Ollama, streaming)
└── static/
    └── index.html     # Giao diện web (HTML/CSS/JS thuần)
```

## Cấu hình mặc định (trong `server.py`)

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

**Cách 1 - Sửa trực tiếp trong `server.py`**: Mở file, sửa giá trị các biến ở đầu file, lưu và khởi động lại server.

**Cách 2 - Thay đổi trên giao diện web** (không cần sửa code):
- **Model**: Chọn từ dropdown trên thanh công cụ
- **Ollama URL**: Nhập URL vào ô text trên thanh công cụ
- **Temp**: Nhập giá trị temperature (0-2) vào ô số trên thanh công cụ
- **System Prompt**: Bấm nút ⚙ để mở panel settings, sửa system prompt

> **Lưu ý**: Thay đổi trên giao diện chỉ có hiệu lực trong phiên hiện tại. Khi reload trang, các giá trị sẽ trở về mặc định trong `server.py`.

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
| `/api/models` | GET | Lấy danh sách model từ Ollama (`?url=<ollama_url>`) |
| `/api/chat` | POST | Gửi tin nhắn chat, trả về stream NDJSON gồm `{"t":"think","d":"..."}` (phần suy nghĩ) và `{"t":"content","d":"..."}` (câu trả lời) |
