@echo off
chcp 936 >nul
cd /d "%~dp0"

rem 有打包好的 exe 就直接用（不需要安装 Python）
if exist "%~dp0mdreader.exe" (
    start "" "%~dp0mdreader.exe" %*
    exit /b 0
)

echo.
echo   正在启动 Markdown 阅读器...
echo   （关掉这个窗口就退出）
echo.
python mdreader.py %*
if errorlevel 1 (
  echo.
  echo   启动失败。请确认已安装 Python 3 并加入 PATH，
  echo   或者把 mdreader.exe 放到本目录。
  pause
)
