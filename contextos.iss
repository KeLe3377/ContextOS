; ============================================
; ContextOS Windows Installer (Inno Setup 6) - Minimal Version
; ============================================

[Setup]
; 必填基础配置
AppName=ContextOS
AppVersion=0.1.0
DefaultDirName={pf}\ContextOS
DefaultGroupName=ContextOS
; 输出配置
OutputDir=inst
OutputBaseFilename=contextos-installer
; 界面选项：禁用目录页，使用默认值
DisableDirPage=yes

[Files]
; 源码文件
Source: "package.json"; DestDir: "{pf}\ContextOS"
Source: "scripts\start-contextos.ps1"; DestDir: "{pf}\ContextOS"
Source: "frontend\dist\*"; DestDir: "{pf}\ContextOS"

[Run]
; 安装完成后弹出提示（不自动启动）
Filename: "{cmd}"; Parameters: "/c echo ContextOS 已安装。请打开 CMD，cd 到安装目录，运行 npm install && npm run start:local"

[Uninstall]
; 删除快捷方式 (使用完整路径)
Name: "C:\Users\%USERNAME%\Desktop\ContextOS"; Status: remove
Name: "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ContextOS"; Status: remove
; 清理用户数据目录下的启动脚本
FilesDelete: "{userappdata}\ContextOS\start-contextos.cmd"

[Codes]
var
  InstallPath: string;
procedure CurStepChanged(CurStep: Integer);
var
  npmCmd: string;
begin
  if CurStep = ssPostInstall then
  begin
    InstallPath := ExpandConstant('{installdir}');
    npmCmd := 'cd "' + InstallPath + '" && npm install && npm run start:local';
    MsgBox('ContextOS 安装完成' + #13#10 +
           '安装路径: ' + InstallPath + #13#10 +
           '首次运行命令: ' + npmCmd, mbInformation, MB_OK, MB_SETFOREGROUND);
  end;
end;

[Icons]
; 使用完整路径创建桌面和开始菜单快捷方式
Name: "C:\Users\%USERNAME%\Desktop\ContextOS"; Filename: "{app}\scripts\start-contextos.ps1"
Name: "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ContextOS"; Filename: "{app}\scripts\start-contextos.ps1"