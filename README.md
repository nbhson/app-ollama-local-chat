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
