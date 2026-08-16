# Danh sách feature đề xuất

Danh sách các feature có thể thêm vào ứng dụng Ollama Chat Web, phân theo nhóm.

## 🧠 Đối thoại & Context

1. **Tiêu đề hội thoại tự động** — chuyện trò nhiều vòng, tự sinh title từ nội dung, hiển thị sidebar danh sách conversation, lưu vào localStorage
2. **Regenerate / Retry** — nút "thử lại" cho response cuối, sửa tin nhắn gốc rồi gửi lại
3. **Edit + Resend** — sửa tin nhắn user đã gửi, replay từ điểm đó (cắt bỏ branch cũ)
4. **Xóa/xuất hội thoại** — nút xóa toàn bộ, export chat ra Markdown/JSON/plain text
5. **Rename hội thoại** — đổi tên thủ công, không chỉ tự động
6. **Tìm kiếm trong lịch sử** — ô search lọc message theo keyword

## ⚡ Hiệu suất & Trải nghiệm

7. **Scroll lock tự động** — auto-scroll xuống khi streaming, nhưng nếu user cuộn lên thì dừng (không giật màn hình)
8. **Token count / cost estimator** — hiển thị số token tiêu thụ mỗi response, tổng phiên
9. **Thời gian response** — hiện latency: "x.xs, y tokens/s"
10. **Copy code block** — nút copy trên từng khối code (hiện đang pre-wrap đơn thuần)
11. **Markdown rendering** — bật render markdown (code highlight, table, list) thay vì text thô, kèm toggle raw/rendered
12. **Word wrap toggle** — chế độ wrap ngắn/dài như terminal

## 🔧 Cấu hình

13. **Num predict / context length** — thêm slider/input cho `num_predict`, `num_ctx` trong options
14. **Seed / top_p / top_k** — expose thêm tham số sampling cho power user
15. **Save settings** — lưu cấu hình (model, URL, temp, system prompt) vào localStorage, tự áp dụng khi reload
16. **Default system prompt presets** — dropdown chọn preset: "Code assistant", "Translator", "Công thức ngắn gọn", v.v.
17. **Multiple Ollama servers** — lưu danh sách URL, chuyển đổi nhanh, lưu model riêng cho từng server

## 🗂 Hội thoại đa model

18. **So sánh model A/B** — gửi cùng câu hỏi cho 2 model, hiển thị side-by-side
19. **Prompt template / custom endpoint** — lưu các prompt có sẵn (prompt library), gọi nhanh 1 click

## 🎤 Đa phương tiện

20. **Playback audio response** — nếu model hỗ trợ output audio (qwen2.5-omni), hiển thị nút nghe
21. **Kéo thả file đa loại** — hỗ trợ cả text/pdf/docx (server đọc và chuyển thành text) cho model không vision
22. **Screenshot paste** — Ctrl+V ảnh từ clipboard vào chat

## 🛠 Tích hợp

23. **Export ra file** — nút "Lưu" ghi hội thoại ra file trên server (không cần copy tay)
24. **Multi-user sessions** — cho phép vài người dùng chung server, mỗi người một conversation riêng
25. **Prompts chạy server-side** — system prompt / model per-request API, cho phép script bên ngoài gọi

## 🖥 UI/UX

26. **Dark/light theme toggle** — thêm theme sáng
27. **Font size điều chỉnh** — Ctrl+/- giống terminal thật
28. **Keyboard shortcuts** — `Ctrl+L` xóa màn hình, `Ctrl+↑/↓` chuyển model, `Ctrl+R` regenerate
29. **Mention model per-message** — gõ `@model` trong tin nhắn để chuyển model cho message đó (giống ChatGPT)
30. **Số model mạnh hơn hiển thị** — badges như "12B", "262k ctx", "nvfp4" cạnh mỗi model trong dropdown

## Ưu tiên đề xuất

Nhóm dễ làm + giá trị cao nhất:

| # | Feature | Lý do ưu tiên |
|---|---------|---------------|
| 15 | Save settings | Cấu hình cá nhân tự áp dụng mỗi lần mở |
| 2 | Regenerate | Sửa nhanh response tệ, không cần gõ lại |
| 11 | Markdown render | Code/table/list hiển thị đẹp, dễ đọc |
| 7 | Scroll lock | Streaming không giật màn hình khi đang đọc |
| 1 | Conversation sidebar | Quản lý nhiều hội thoại, không mất khi reload |