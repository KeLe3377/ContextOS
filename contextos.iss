; ============================================
; ContextOS Windows Installer (Inno Setup 6)
; 打包内容：编译后的 daemon 产物 + 前端静态资源 + 数据库迁移 + 启动脚本
; ============================================

[Setup]
AppName=ContextOS
AppVersion=0.1.3
AppVerName=ContextOS 0.1.3
AppPublisher=ContextOS
DefaultDirName={localappdata}\ContextOS
DefaultGroupName=ContextOS
UninstallDisplayName=ContextOS 0.1.3
OutputDir=inst
OutputBaseFilename=contextos-installer
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Files]
; 包描述与依赖锁文件
Source: "package.json"; DestDir: "{app}"
Source: "package-lock.json"; DestDir: "{app}"

; 启动脚本
Source: "scripts\start-contextos.ps1"; DestDir: "{app}\scripts"
Source: "scripts\start-contextos.cmd"; DestDir: "{app}\scripts"

; 编译后的 daemon 产物（tsc 输出到 dist，运行时只需要 apps / packages）
Source: "dist\apps\*"; DestDir: "{app}\dist\apps"; Flags: recursesubdirs createallsubdirs
Source: "dist\packages\*"; DestDir: "{app}\dist\packages"; Flags: recursesubdirs createallsubdirs

; 数据库迁移文件（daemon 启动时从 <安装目录>/migrations 读取）
Source: "migrations\*"; DestDir: "{app}\migrations"

; 前端静态资源（daemon 从 <安装目录>/frontend/dist 提供）
Source: "frontend\dist\*"; DestDir: "{app}\frontend\dist"; Flags: recursesubdirs createallsubdirs

[Run]
; 只安装运行时依赖（编译产物不需要 tsx 等 devDependencies）
Filename: "{cmd}"; Parameters: "/c cd /d ""{app}"" && npm install --omit=dev --no-audit --no-fund"; StatusMsg: "正在安装运行依赖（首次安装需要联网，约 1-2 分钟）..."

[Icons]
; 桌面和开始菜单快捷方式（指向批处理脚本，自带 pause 机制，杜绝闪退）
Name: "{userdesktop}\ContextOS.lnk"; Filename: "{app}\scripts\start-contextos.cmd"; WorkingDir: "{app}"; Comment: "启动 ContextOS 本地服务"
Name: "{userprograms}\ContextOS\ContextOS.lnk"; Filename: "{app}\scripts\start-contextos.cmd"; WorkingDir: "{app}"; Comment: "启动 ContextOS 本地服务"
Name: "{userprograms}\ContextOS\卸载 ContextOS.lnk"; Filename: "{uninstallexe}"

[UninstallDelete]
; 只清理开机启动脚本，用户数据目录（Roaming AppData\ContextOS）保留
Type: files; Name: "{userstartup}\ContextOS.cmd"
; npm install 装的运行时依赖不在安装清单里，需要显式清理，否则卸载后会留下 node_modules
Type: filesandordirs; Name: "{app}\node_modules"
Type: dirifempty; Name: "{app}"

[Codes]
procedure CurStepChanged(CurStep: Integer);
var
  InstallPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    InstallPath := ExpandConstant('{app}');
    MsgBox('ContextOS 安装完成。' + #13#10 + #13#10 +
           '安装路径: ' + InstallPath + #13#10 +
           '用户数据: ' + ExpandConstant('{userappdata}') + '\ContextOS\.contextos' + #13#10 + #13#10 +
           '双击桌面上的 ContextOS 快捷方式即可启动，' + #13#10 +
           '启动后浏览器会自动打开 http://127.0.0.1:4721/ 。' + #13#10 + #13#10 +
           '提示：首次启动若提示缺少依赖，请在安装目录执行 npm install。',
           mbInformation, MB_OK, MB_SETFOREGROUND);
  end;
end;
