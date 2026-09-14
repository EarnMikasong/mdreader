@echo off
chcp 936 >nul
cd /d "%~dp0"

rem ===== 把 mdreader 注册成 .md 的打开方式（只写 HKCU，不需要管理员） =====

rem 优先用打包好的 mdreader.exe，完全不依赖 Python 环境
if exist "%~dp0mdreader.exe" (
    set "RUNCMD=\"%~dp0mdreader.exe\""
    set "ICON=%~dp0mdreader.exe,0"
    goto :reg
)

rem 没有 exe 时退回 pythonw.exe（双击 md 时不弹黑窗口）
set "PYW="
for /f "delims=" %%i in ('where pythonw.exe 2^>nul') do if not defined PYW set "PYW=%%i"
if not defined PYW (
    echo [错误] 本目录没有 mdreader.exe，系统里也没找到 pythonw.exe。
    echo 请把 mdreader.exe 放回来，或安装 Python 并勾选 "Add python.exe to PATH"。
    pause
    exit /b 1
)
set "RUNCMD=\"%PYW%\" \"%~dp0mdreader.py\""
set "ICON=%PYW%,0"

:reg
rem 1) 右键菜单「用 mdreader 阅读」—— 这个最可靠，任何时候都能用
for %%E in (.md .markdown .mdown .mkd .mdx) do (
    reg add "HKCU\Software\Classes\SystemFileAssociations\%%E\shell\mdreader" /ve /d "用 mdreader 阅读" /f >nul
    reg add "HKCU\Software\Classes\SystemFileAssociations\%%E\shell\mdreader" /v Icon /d "%ICON%" /f >nul
    reg add "HKCU\Software\Classes\SystemFileAssociations\%%E\shell\mdreader\command" /ve /d "%RUNCMD% \"%%1\"" /f >nul
)

rem 2) ProgID + 默认关联 —— 让双击也能打开（若系统里已有你手选过的默认程序，它会优先）
reg add "HKCU\Software\Classes\mdreader.doc" /ve /d "Markdown 文档" /f >nul
reg add "HKCU\Software\Classes\mdreader.doc\DefaultIcon" /ve /d "%ICON%" /f >nul
reg add "HKCU\Software\Classes\mdreader.doc\shell\open\command" /ve /d "%RUNCMD% \"%%1\"" /f >nul
for %%E in (.md .markdown) do (
    reg add "HKCU\Software\Classes\%%E" /ve /d "mdreader.doc" /f >nul
    reg add "HKCU\Software\Classes\%%E\OpenWithProgids" /v mdreader.doc /t REG_SZ /d "" /f >nul
)

echo.
echo 注册完成：
echo   * 在 .md 文件上右键，会出现「用 mdreader 阅读」
echo   * 双击 .md 一般会直接打开；如果被别的程序抢走，
echo     在文件上 右键 - 打开方式 - 选择其他应用，选一次 "Markdown 文档" 并勾选始终。
echo   * 想撤销就运行 取消关联.bat
echo.
pause
