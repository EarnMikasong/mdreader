@echo off
chcp 936 >nul

rem ===== 撤销 设为md打开方式.bat 写入的所有注册表项（只动 HKCU） =====

for %%E in (.md .markdown .mdown .mkd .mdx) do (
    reg delete "HKCU\Software\Classes\SystemFileAssociations\%%E\shell\mdreader" /f >nul 2>nul
)

reg delete "HKCU\Software\Classes\mdreader.doc" /f >nul 2>nul

for %%E in (.md .markdown) do (
    reg delete "HKCU\Software\Classes\%%E\OpenWithProgids" /v mdreader.doc /f >nul 2>nul
    rem 只有当默认值还是我们写的 mdreader.doc 时才删掉，不动用户自己设过的关联
    set "CUR="
    for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\Software\Classes\%%E" /ve 2^>nul') do set "CUR=%%b"
    setlocal enabledelayedexpansion
    if "!CUR!"=="mdreader.doc" reg delete "HKCU\Software\Classes\%%E" /ve /f >nul 2>nul
    endlocal
)

echo 已取消 mdreader 的文件关联。
pause
