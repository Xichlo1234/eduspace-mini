@echo off
REM Duong dan thu nghiem tam thoi qua Cloudflare (khong can tai khoan). Moi lan chay ra mot dia chi https://....trycloudflare.com khac.
cloudflared tunnel --url http://localhost:3000
pause
