@echo off
chcp 936 >nul

rem ===== 关闭在后台运行的 mdreader（占用 7333 端口的进程） =====

set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7333" ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>nul
    set "KILLED=1"
)

if defined KILLED (
    echo mdreader 已退出。
) else (
    echo 没有发现正在运行的 mdreader。
)
pause
