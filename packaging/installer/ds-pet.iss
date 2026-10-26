; ============================================================================
;  ds-pet 安装程序（Inno Setup 6）
;
;  界面：整窗渐变背景 + 左上 logo/标题（都画在图里）；每页一张背景图，
;        页面标题/正文也画在图上（不用界面控件，避免白底块与字距被拉宽）。
;        右上角自绘 ✕ 关闭、⠿ 移动；按钮 = 图片底（从背景采样，圆角无缝）+ 透明文字。
;
;  编译：ISCC.exe installer\ds-pet.iss
; ============================================================================

#define MyAppName "ds-pet"
#define MyAppVersion "0.3.8"
; 版权/发布者：项目在 GitHub 的 PC2005-cloud 名下；安装包由 liyue 打包
#define MyAppPublisher "PC2005-cloud"
#define MyAppCopyright "Copyright (C) 2026 PC2005-cloud (github.com/PC2005-cloud) - Packaged by liyue"
#define MyAppExeName "ds-pet.exe"
#define MyAppId "{{7C4B2F18-6E3A-4C71-9B4E-2D8A61F0C5E3}"

; 路径基准 = 本文件所在目录（packaging\installer）
;   ..\        -> packaging
;   ..\..\     -> dsh-pet-main
;   程序与字体在 dsh-pet 子项目里
#define SrcDir "..\..\dsh-pet\dist-app\win-unpacked"
#define AssetDir "..\assets"
#define FontDir "..\..\dsh-pet\assets\fonts"

#define WinW 1000
#define WinH 620
#define ContentX 380
#define ContentW 580
#define ContentY 150

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/PC2005-cloud
AppSupportURL=https://github.com/PC2005-cloud
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} Setup
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright={#MyAppCopyright}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableReadyPage=yes
AllowNoIcons=yes
; 直接生成到桌面。
; 注意：OutputDir 不展开 {userdesktop} 这类运行时常量（实测会建出一个名叫 "{userdesktop}" 的目录），
; 只能写绝对路径。
OutputDir=C:\Users\liyueovo\Desktop
OutputBaseFilename=ds-pet-setup-{#MyAppVersion}
SetupIconFile={#AssetDir}\logo.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no
LanguageDetectionMethod=none
UsePreviousAppDir=yes
AppMutex=ds-pet-setup-mutex
DisableDirPage=no
DisableWelcomePage=no
UninstallDisplayName={#MyAppName}

[Languages]
; 两个文件叠加：默认英文打底，ChineseCover.isl 覆盖成中文并把进程 UI 语言切到 zh-CN，
; 这样连 Windows 的"选文件夹"系统对话框也是中文按钮。
Name: "zh"; MessagesFile: "compiler:Default.isl,ChineseCover.isl"

; Inno 自己的确认框（取消安装那一套）改成中文
[Messages]
SetupAppTitle=ds-pet 安装程序
SetupWindowTitle=ds-pet 安装程序
ExitSetupTitle=退出安装
ExitSetupMessage=安装还没完成，现在退出的话 ds-pet 不会被安装。%n%n确定退出吗？
; 安装中状态行（原来是英文的 "Extracting files..."）：两个键都要覆盖，
; 实际显示的那句来自 StatusExtractFiles
ExtractingLabel=正在解压文件…
StatusExtractFiles=正在解压文件…
; 目录已存在的确认框（原来标题和正文都是英文）
DirExistsTitle=文件夹已存在
DirExists=这个文件夹：%n%n%1%n%n已经存在了。要安装到这里吗？
; 附加选项页：分组标题与任务描述（默认是 "Additional shortcuts:" / "Create a &desktop shortcut"）
AdditionalIcons=附加图标：
CreateDesktopIcon=创建桌面快捷方式
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonOK=确定
ButtonCancel=取消

[CustomMessages]
zh.BtnNext=下一步
zh.BtnInstall=安装
zh.BtnFinish=完成
zh.BtnBack=上一步
zh.BtnCancel=取消
zh.Close=关闭
zh.LaunchApp=立即运行 ds-pet

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startupicon"; Description: "开机自动运行 ds-pet"; Flags: unchecked

[Files]
Source: "{#AssetDir}\background.bmp"; DestDir: "{tmp}"; Flags: dontcopy
; 窗口/任务栏图标：SetupIconFile 只改 exe 文件资源，向导窗口的 WizardForm.Icon 得自己设
Source: "{#AssetDir}\logo.ico"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\bg-welcome.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\bg-dir.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\bg-tasks.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\bg-installing.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\bg-finished.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\btn-primary.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\btn-ghost-back.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\btn-ghost-cancel.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\check-on.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#AssetDir}\check-off.bmp"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#FontDir}\上首软糖体.ttf"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#FontDir}\上首软糖体.ttf"; DestDir: "{app}\fonts"; Flags: ignoreversion
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
; 是否创建用 Check: 决定 —— 勾选界面是自绘的两个小方框，不再依赖 Inno 的任务列表控件
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Check: WantDesktopIcon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Check: WantStartupIcon

; 「立即运行」不用 [Run] + postinstall：那样会生成一个不透明白底的勾选列表。
; 改由脚本在完成页点「完成」时自行启动（见 NextClicked），勾选状态在 WantLaunch 里。
[Run]

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  FR_PRIVATE = $10;
  WM_SYSCOMMAND = $0112;
  // 无边框窗口拖动：SC_DRAGMOVE 等价于"按住标题栏拖"（SC_MOVE 在 bsNone 窗口上不生效）
  SC_DRAGMOVE = $F012;
  CLR_DIM = $00807A72;
  CLR_BTN_TEXT = $003A2E22;
  CLR_PICK_TEXT = $00735A2F;

var
  Backdrop: TBitmapImage;
  DragBar: TLabel;
  CloseBtn, PickBtn: TLabel;
  // 附加选项：自绘的两个勾选小图标（不用 Inno 的 TasksList —— 那个控件不透明白底、字距也会被拉宽）
  CheckDesktop, CheckStartup, CheckLaunch: TBitmapImage;
  // 自绘进度条：浅色槽画在背景图上，这块青绿填充按进度伸缩；PathLabel 显示正在解压的文件。
  // 填充用 TLabel 而不是 TPanel：TPanel 的 Color 在 Inno 的主题绘制下不生效（实测整条槽空的），
  // TLabel 设 Transparent=False 后会用自己的 Color 铺底，宽度可控。
  ProgressFill: TLabel;
  PathLabel: TLabel;
  WantDesktop, WantStartup, WantLaunch: Boolean;
  BtnNext, BtnBack, BtnCancel: TBitmapImage;
  BtnNextText, BtnBackText, BtnCancelText: TLabel;
  UiFont: String;
  FontLoaded: Boolean;

{ ---------- Win32 ---------- }
function SendMessage(hWnd: HWND; Msg: Cardinal; wParam: Longint; lParam: Longint): Longint;
  external 'SendMessageW@user32.dll stdcall';
function ReleaseCapture: Boolean; external 'ReleaseCapture@user32.dll stdcall';
function LoadImage(hinst: THandle; lpszName: String; uType, cx, cy, fuLoad: Cardinal): THandle;
  external 'LoadImageW@user32.dll stdcall';
function FindWindow(ClassName, WindowName: String): THandle;
  external 'FindWindowW@user32.dll stdcall';
{ 类图标：任务栏按钮最终读的是窗口类图标（WM_SETICON 只改窗口实例，改不动任务栏） }
function SetClassLong(hWnd: THandle; nIndex: Integer; dwNewLong: Longint): Longint;
  external 'SetClassLongW@user32.dll stdcall';

{ 把窗口图标换成包内的 logo.ico：任务栏用 ICON_BIG（32），标题栏/Alt+Tab 用 ICON_SMALL（16）。
  Inno 的 TSetupForm 没暴露 Icon 属性，只能走 WM_SETICON。 }
procedure SetWindowIcon();
var
  P: String;
  H, H2, AppH: THandle;
  R1, R2: Longint;
begin
  P := ExpandConstant('{tmp}\logo.ico');
  H := LoadImage(0, P, 1 {IMAGE_ICON}, 32, 32, $10 {LR_LOADFROMFILE});
  H2 := LoadImage(0, P, 1, 16, 16, $10);
  R1 := 0; R2 := 0;
  if H <> 0 then R1 := SendMessage(WizardForm.Handle, $0080 {WM_SETICON}, 1 {ICON_BIG}, H);
  if H2 <> 0 then R2 := SendMessage(WizardForm.Handle, $0080, 0 {ICON_SMALL}, H2);
  // 任务栏按钮其实挂在 Delphi 的 TApplication 窗口上（枚举窗口时能看到它 visible=True、
  // 标题为空）——两边的 WM_SETICON 都设一遍。
  AppH := FindWindow('TApplication', '');
  if (AppH <> 0) and (H <> 0) then SendMessage(AppH, $0080, 1, H);
  if (AppH <> 0) and (H2 <> 0) then SendMessage(AppH, $0080, 0, H2);

  // 真正决定任务栏按钮的是**窗口类图标**（GCL_HICON = -14 / GCL_HICONSM = -34）：
  // 只发 WM_SETICON 时任务栏依旧显示 Inno 自带的蓝窗口图标（实测对比：关掉安装程序它就消失，
  // 确认那个按钮就是它）。
  if H <> 0 then
  begin
    SetClassLong(WizardForm.Handle, -14, H);
    if AppH <> 0 then SetClassLong(AppH, -14, H);
  end;
  if H2 <> 0 then
  begin
    SetClassLong(WizardForm.Handle, -34, H2);
    if AppH <> 0 then SetClassLong(AppH, -34, H2);
  end;

end;
function CreateRoundRectRgn(x1, y1, x2, y2, w, h: Integer): THandle;
  external 'CreateRoundRectRgn@gdi32.dll stdcall';
function SetWindowRgn(hWnd: HWND; hRgn: THandle; bRedraw: Boolean): Integer;
  external 'SetWindowRgn@user32.dll stdcall';

{ ---------- 字体 ---------- }
function AddFontResourceEx(lpszFilename: String; fl: DWORD; pdv: Cardinal): Integer;
  external 'AddFontResourceExW@gdi32.dll stdcall';
function RemoveFontResourceEx(lpszFilename: String; fl: DWORD; pdv: Cardinal): Integer;
  external 'RemoveFontResourceExW@gdi32.dll stdcall';

procedure LoadUiFont();
var
  P: String;
begin
  FontLoaded := False;
  UiFont := 'Microsoft YaHei UI';
  P := ExpandConstant('{tmp}\上首软糖体.ttf');
  if FileExists(P) and (AddFontResourceEx(P, FR_PRIVATE, 0) <> 0) then
  begin
    UiFont := '上首软糖体';
    FontLoaded := True;
  end;
end;

procedure UnloadUiFont();
begin
  if FontLoaded then
    RemoveFontResourceEx(ExpandConstant('{tmp}\上首软糖体.ttf'), FR_PRIVATE, 0);
end;

{ ---------- 控件 ---------- }
function MakeText(AParent: TWinControl; const AText: String; ASize: Integer; AColor: TColor): TLabel;
var
  L: TLabel;
begin
  L := TLabel.Create(WizardForm);
  L.Parent := AParent;
  L.AutoSize := False;
  L.Transparent := True;
  L.Caption := AText;
  L.Font.Name := UiFont;
  L.Font.Size := ASize;
  L.Font.Color := AColor;
  Result := L;
end;

function MakeImageButton(AParent: TWinControl; const AFile: String; ALeft, ATop, AW, AH: Integer;
  AText: String; ATextColor: TColor; AOnClick: TNotifyEvent; var AImg: TBitmapImage; var ALabel: TLabel): Boolean;
begin
  AImg := TBitmapImage.Create(WizardForm);
  AImg.Parent := AParent;
  AImg.SetBounds(ALeft, ATop, AW, AH);
  AImg.Cursor := crHand;
  AImg.OnClick := AOnClick;
  AImg.Bitmap.LoadFromFile(ExpandConstant('{tmp}\' + AFile));

  // TBitmapImage 不是 TWinControl（不能当父容器），文字挂在窗体上、按绝对坐标压在按钮中央
  ALabel := MakeText(WizardForm, AText, 11, ATextColor);
  ALabel.SetBounds(ALeft, ATop, AW, AH);
  ALabel.Alignment := taCenter;
  ALabel.Layout := tlCenter; // 垂直居中（TLabel 有这个属性；之前漏了，文字贴在按钮顶部）
  ALabel.Cursor := crHand;
  ALabel.OnClick := AOnClick;
  Result := True;
end;

{ ---------- 动作 ---------- }
{ 自绘按钮 -> 原生按钮：发 BM_CLICK（$00F5）比调 OnClick 可靠得多。
  原生按钮被挪到窗口外之后，OnClick 事件已经不可用（点了没反应就是这个原因），
  但按钮句柄还在、Enabled 照样由 Inno 维护，BM_CLICK 走的是真正的按钮点击路径。 }
{ 附加选项的两个勾选小图标：点一下切换，图片随之换 }
procedure RefreshChecks();
begin
  if WantDesktop then
    CheckDesktop.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-on.bmp'))
  else
    CheckDesktop.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-off.bmp'));
  if WantStartup then
    CheckStartup.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-on.bmp'))
  else
    CheckStartup.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-off.bmp'));
end;

procedure ToggleDesktop(Sender: TObject);
begin
  WantDesktop := not WantDesktop;
  RefreshChecks();
end;

procedure ToggleStartup(Sender: TObject);
begin
  WantStartup := not WantStartup;
  RefreshChecks();
end;

procedure ToggleLaunch(Sender: TObject);
begin
  WantLaunch := not WantLaunch;
  if WantLaunch then
    CheckLaunch.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-on.bmp'))
  else
    CheckLaunch.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-off.bmp'));
end;

{ [Icons] 的 Check: 回调 —— 返回 True 才创建 }
function WantDesktopIcon(): Boolean;
begin
  Result := WantDesktop;
end;

function WantStartupIcon(): Boolean;
begin
  Result := WantStartup;
end;

{ 自绘按钮 -> 向导前进。
  三层兜底，每层都用 CurPageID 判断有没有真的翻页：
    1. BM_CLICK（TButton 处理"被点击"的正规消息）
    2. 直接把焦点给原生按钮 + 空格
    3. 直接调用按钮的 OnClick 事件
  原生按钮只是被挪到窗口外，句柄、Enabled、OnClick 都由 Inno 正常维护。 }
procedure NextClicked(Sender: TObject);
var
  Before: Integer;
begin
  // 完成页点「完成」：按勾选状态决定要不要启动刚装好的程序（原来靠 [Run] + RunList 实现）
  if (WizardForm.CurPageID = wpFinished) and WantLaunch then
  begin
    try
      Exec(ExpandConstant('{app}\{#MyAppExeName}'), '', ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, Before);
    except
    end;
  end;

  // 这里**不能**先判断 Enabled 再返回：原生按钮被挪到窗口外之后，它的 Enabled 未必
  // 与当前页同步（为 False 时函数会直接退出，表现就是"点了毫无反应"）。
  // 所以无条件往下走：BM_CLICK 自己会看 Enabled，OnClick 直调则绕过它。
  Before := WizardForm.CurPageID;

  SendMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
  if WizardForm.CurPageID <> Before then Exit;

  try
    WizardForm.NextButton.OnClick(WizardForm.NextButton);
  except
  end;
end;

procedure BackClicked(Sender: TObject);
begin
  if WizardForm.BackButton.Enabled then
    SendMessage(WizardForm.BackButton.Handle, $00F5, 0, 0);
end;

procedure CancelClicked(Sender: TObject);
begin
  SendMessage(WizardForm.CancelButton.Handle, $00F5, 0, 0);
end;

procedure CloseClicked(Sender: TObject);
begin
  SendMessage(WizardForm.CancelButton.Handle, $00F5, 0, 0);
end;

{ 无标题栏窗口的移动：模拟"按住标题栏"。
  注意 SC_DRAGMOVE（$F012）而不是 SC_MOVE（$F010）——后者要求窗口有非客户区，
  bsNone 窗口没有，系统会直接忽略；SC_DRAGMOVE 才真正进入拖动循环。
  处理函数必须是 TMouseEvent 的签名（Sender; Button; Shift; X; Y）——
  之前写成 (Sender: TObject) 就是那次编译失败的原因，不是控件不支持。 }
procedure DragWindow(Sender: TObject; Button: TMouseButton; Shift: TShiftState; X, Y: Integer);
begin
  if Button = mbLeft then
  begin
    ReleaseCapture;
    SendMessage(WizardForm.Handle, WM_SYSCOMMAND, SC_DRAGMOVE, 0);
  end;
end;



{ 「选择」按钮：调原生目录浏览（隐藏的 Browse 按钮仍保留完整逻辑） }
procedure PickClicked(Sender: TObject);
begin
  WizardForm.DirBrowseButton.OnClick(WizardForm.DirBrowseButton);
end;

{ ---------- 背景按页切换 ---------- }
procedure LoadBackdrop(PageID: Integer);
var
  Name: String;
begin
  case PageID of
    wpWelcome: Name := 'bg-welcome.bmp';
    wpSelectDir: Name := 'bg-dir.bmp';
    // 附加选项页（桌面快捷方式 / 开机自启）：以前没有这一项，落到 else 就显示成欢迎页，
    // 表现为"安装位置之后又多出一个欢迎使用"。
    wpSelectTasks: Name := 'bg-tasks.bmp';
    // wpPreparing 是"准备安装"页（解压前的几秒）。以前漏了它，case 落到 else 就加载了
    // 欢迎页背景 —— 用户看到"安装位置后面又多出一个欢迎使用"。
    wpPreparing: Name := 'bg-installing.bmp';
    wpInstalling: Name := 'bg-installing.bmp';
    wpFinished: Name := 'bg-finished.bmp';
  else
    Name := 'bg-welcome.bmp';
  end;
  Backdrop.Bitmap.LoadFromFile(ExpandConstant('{tmp}\' + Name));
end;

{ ---------- 刷新 ---------- }
procedure RefreshUi();
var
  Cw, BtnY: Integer;
begin
  Cw := {#ContentW};
  // 按钮离底边留 40px（之前 30 太贴边，完成页看着会"往下掉"）
  BtnY := {#WinH} - 40 - 40;

  BtnNext.SetBounds({#WinW} - 132 - 34, BtnY, 132, 40);
  BtnBack.SetBounds({#WinW} - 132 - 34 - 110 - 10, BtnY, 110, 40);
  BtnCancel.SetBounds(34, BtnY, 110, 40);

  // 文字必须与按钮**完全同框**：之前只同步了 Left，还额外 +10 偏移，
  // 结果文字整体偏右下（用户看到的就是"按钮文字偏移"）。
  BtnNextText.SetBounds(BtnNext.Left, BtnNext.Top, BtnNext.Width, BtnNext.Height);
  BtnBackText.SetBounds(BtnBack.Left, BtnBack.Top, BtnBack.Width, BtnBack.Height);
  BtnCancelText.SetBounds(BtnCancel.Left, BtnCancel.Top, BtnCancel.Width, BtnCancel.Height);

  WizardForm.NextButton.SetBounds(-400, -400, 1, 1);
  WizardForm.BackButton.SetBounds(-400, -400, 1, 1);
  WizardForm.CancelButton.SetBounds(-400, -400, 1, 1);

  LoadBackdrop(WizardForm.CurPageID);
  PickBtn.Visible := WizardForm.CurPageID = wpSelectDir;
  LoadBackdrop(WizardForm.CurPageID);
  PickBtn.Visible := WizardForm.CurPageID = wpSelectDir;

  // 内容笔记本永久隐藏：它自带白底和 Inno 的装饰插图，而且每次切页还会被排回默认布局。
  // 需要的原生控件（路径框 / 进度条 / 状态行 / 完成页勾选）全部单独挂到窗体上。
  WizardForm.OuterNotebook.Visible := False;

  // 从笔记本里挪出来的控件不受向导管显隐控制，每页都要先关掉（否则会跟着出现在所有页面）
  WizardForm.DirEdit.Visible := False;
  WizardForm.StatusLabel.Visible := False;
  // FilenameLabel 不隐藏、只是挪到窗口外：Inno 只对"可见"控件持续更新文字，
  // 隐藏后就收不到"正在解压 xxx"了。挪出去仍然可见，我们读它的 Caption 转给 PathLabel。
  WizardForm.FilenameLabel.SetBounds(-400, -400, 1, 1);
  ProgressFill.Visible := False;
  PathLabel.Visible := False;
  WizardForm.ProgressGauge.Visible := False;
  WizardForm.TasksList.Visible := False;
  CheckDesktop.Visible := False;
  CheckStartup.Visible := False;
  CheckLaunch.Visible := False;
  if WizardForm.RunList <> nil then WizardForm.RunList.Visible := False;

  BtnNext.Visible := True;
  BtnCancel.Visible := True;
  BtnNextText.Caption := ExpandConstant('{cm:BtnNext}');

  case WizardForm.CurPageID of
    wpSelectDir:
      begin
        BtnNextText.Caption := ExpandConstant('{cm:BtnInstall}');
        WizardForm.SelectDirLabel.Visible := False;
        WizardForm.DirBrowseButton.Visible := False;
        WizardForm.DiskSpaceLabel.Visible := False;
        // 输入框对准背景图上画好的白色圆角框（(380,186) 512×38），文字内缩 8px
        WizardForm.DirEdit.Parent := WizardForm;
        WizardForm.DirEdit.SetBounds({#ContentX} + 8, 192, 494, 26);
        WizardForm.DirEdit.Visible := True;
        WizardForm.DirEdit.Color := clWhite;
        WizardForm.DirEdit.Font.Name := UiFont;
        WizardForm.DirEdit.Font.Size := 11;
      end;
    wpSelectTasks:
      begin
        BtnNextText.Caption := ExpandConstant('{cm:BtnInstall}');
        // Inno 的任务列表控件全程隐藏；条目文字已经画在背景图上，
        // 这里只把两个可点击的小方框叠在文字左边（位置与 bg-tasks.bmp 里留的 24px 空档对齐）
        CheckDesktop.Visible := True;
        CheckStartup.Visible := True;
      end;
    // 准备安装页与安装页共用同一套界面（背景都用 bg-installing，标题是"正在安装"）
    wpPreparing, wpInstalling:
      begin
        BtnNext.Visible := False;
        // 原生进度条不用（系统绿色方块，改不了颜色）：隐藏它，改用背景图上的槽 + 青绿填充。
        // FilenameLabel 仍留在窗口外 —— 不可见但 Inno 会持续更新它的 Caption，
        // 我们把它抄到透明的 PathLabel 上，于是"正在解压哪个文件"能显示且没有白底。
        WizardForm.ProgressGauge.Visible := False;
        PathLabel.Visible := True;
        ProgressFill.Visible := True;
        // 起始就给一小块：宽度为 0 时整条槽是空的，用户会以为"根本没进度"
        ProgressFill.SetBounds({#ContentX} + 2, 140, 6, 10);
        PathLabel.Caption := '';
      end;
    wpFinished:
      begin
        BtnNextText.Caption := ExpandConstant('{cm:BtnFinish}');
        BtnCancel.Visible := False;
        WizardForm.FinishedLabel.Visible := False;
        WizardForm.FinishedHeadingLabel.Visible := False;
        // 完成页的「立即运行」不再用 Inno 的 RunList（那个控件不透明白底）：
        // 条目文字画在背景图上，勾选是自绘的小图标，启动动作在 NextClicked 里做。
        CheckLaunch.Visible := True;
      end;
  end;

  // 图片按钮与它上面的文字要一起显隐（文字是独立控件，漏了会在没有按钮的地方留一行字）
  BtnBack.Visible := WizardForm.BackButton.Visible;
  BtnBackText.Visible := BtnBack.Visible;
  if BtnBack.Visible then
    BtnBack.Enabled := WizardForm.BackButton.Enabled;

  BtnNextText.Visible := BtnNext.Visible;
  if BtnNext.Visible then
    BtnNext.Enabled := WizardForm.NextButton.Enabled;

  BtnCancelText.Visible := BtnCancel.Visible;
  if BtnCancel.Visible then
    BtnCancel.Enabled := WizardForm.CancelButton.Enabled;
end;

procedure InitializeWizard();
var
  Cw, Ch: Integer;
begin
  ExtractTemporaryFiles('*');
  LoadUiFont();

  WizardForm.BorderStyle := bsNone;
  Cw := {#WinW};
  Ch := {#WinH};
  WizardForm.ClientWidth := Cw;
  WizardForm.ClientHeight := Ch;
  WizardForm.Position := poScreenCenter;
  WizardForm.Color := clWhite;
  // 窗口图标（任务栏 / Alt+Tab 用的就是它）：SetupIconFile 只写进 exe 资源，
  // 向导窗口的图标仍是 Inno 内置的默认那个 —— 这里用 WM_SETICON 显式换掉。
  SetWindowIcon();
  SetWindowRgn(WizardForm.Handle, CreateRoundRectRgn(0, 0, Cw + 1, Ch + 1, 28, 28), True);

  Backdrop := TBitmapImage.Create(WizardForm);
  Backdrop.Parent := WizardForm;
  Backdrop.SetBounds(0, 0, Cw, Ch);
  Backdrop.Stretch := True;
  Backdrop.Bitmap.LoadFromFile(ExpandConstant('{tmp}\bg-welcome.bmp'));

  // 无标题栏窗口的拖动把手：透明 Label 铺在顶部一条（不盖住右上角按钮），
  // 按下左键就 ReleaseCapture + SC_DRAGMOVE，等价于按住标题栏拖动。
  // 宽度留出右侧 100px：那一片是 ✕ / ⠿，被透明 Label 盖住就点不到了。
  DragBar := TLabel.Create(WizardForm);
  DragBar.Parent := WizardForm;
  DragBar.AutoSize := False;
  DragBar.Caption := '';
  DragBar.Transparent := True;
  DragBar.SetBounds(0, 0, Cw - 100, 56);
  DragBar.Cursor := crSizeAll;
  DragBar.OnMouseDown := @DragWindow;

  // 右上角：✕ 关闭（拖动把手已去掉——顶部那一条直接按住就能拖）
  CloseBtn := MakeText(WizardForm, '✕', 13, CLR_DIM);
  CloseBtn.SetBounds(Cw - 44, 12, 26, 24);
  CloseBtn.Alignment := taCenter;
  CloseBtn.Cursor := crHand;
  CloseBtn.OnClick := @CloseClicked;

  // 安装位置页右侧的「选择」按钮：文字压在背景图画的按钮上，点击调原生目录框
  PickBtn := MakeText(WizardForm, '选择', 11, CLR_PICK_TEXT);
  PickBtn.SetBounds(902, 186, 78, 38);
  PickBtn.Alignment := taCenter;
  PickBtn.Layout := tlCenter;
  PickBtn.Cursor := crHand;
  PickBtn.OnClick := @PickClicked;
  PickBtn.Visible := False;

  // 附加选项页的两个勾选小方框（默认：桌面快捷方式勾上、开机自启不勾）
  WantDesktop := True;
  WantStartup := False;
  CheckDesktop := TBitmapImage.Create(WizardForm);
  CheckDesktop.Parent := WizardForm;
  CheckDesktop.SetBounds({#ContentX}, 184, 22, 22);
  CheckDesktop.Cursor := crHand;
  CheckDesktop.OnClick := @ToggleDesktop;
  CheckDesktop.Visible := False;
  CheckStartup := TBitmapImage.Create(WizardForm);
  CheckStartup.Parent := WizardForm;
  CheckStartup.SetBounds({#ContentX}, 224, 22, 22);
  CheckStartup.Cursor := crHand;
  CheckStartup.OnClick := @ToggleStartup;
  CheckStartup.Visible := False;

  // 完成页的「立即运行」勾选（默认勾上）
  WantLaunch := True;
  CheckLaunch := TBitmapImage.Create(WizardForm);
  CheckLaunch.Parent := WizardForm;
  CheckLaunch.SetBounds({#ContentX}, 187, 22, 22);
  CheckLaunch.Cursor := crHand;
  CheckLaunch.OnClick := @ToggleLaunch;
  CheckLaunch.Visible := False;
  CheckLaunch.Bitmap.LoadFromFile(ExpandConstant('{tmp}\check-on.bmp'));

  // 自绘进度条 + 文件路径行（安装页用）
  ProgressFill := TLabel.Create(WizardForm);
  ProgressFill.Parent := WizardForm;
  ProgressFill.AutoSize := False;
  ProgressFill.Transparent := False;
  ProgressFill.Caption := '';
  ProgressFill.Color := $00C0CF6F; // RGB 6FCFC0 青绿（TColor 是 BGR）
  ProgressFill.SetBounds({#ContentX} + 2, 140, 0, 10);
  ProgressFill.Visible := False;

  PathLabel := TLabel.Create(WizardForm);
  PathLabel.Parent := WizardForm;
  PathLabel.AutoSize := False;
  PathLabel.Transparent := True;
  PathLabel.Caption := '';
  PathLabel.Font.Name := UiFont;
  PathLabel.Font.Size := 10;
  PathLabel.Font.Color := $00786B5A; // RGB 5A6B78 中灰蓝
  PathLabel.SetBounds({#ContentX}, 112, {#ContentW}, 20);
  PathLabel.Visible := False;

  // 附加选项页的两个方框：与文字视觉中心对齐。
  // 文字由 GDI+ 画在 186 / 226，软糖体的行框比字号高不少，实际字形中心偏上，
  // 所以方框要略高于文字顶（183 / 223），而不是对齐顶边。
  CheckDesktop.SetBounds({#ContentX}, 183, 22, 22);
  CheckStartup.SetBounds({#ContentX}, 223, 22, 22);

  RefreshChecks();

  WizardForm.PageNameLabel.Visible := False;
  WizardForm.PageDescriptionLabel.Visible := False;
  WizardForm.WelcomeLabel1.Visible := False;
  WizardForm.WelcomeLabel2.Visible := False;

  WizardForm.OuterNotebook.SetBounds({#ContentX}, {#ContentY}, {#ContentW}, 340);

  MakeImageButton(WizardForm, 'btn-primary.bmp', {#WinW} - 132 - 34, {#WinH} - 70, 132, 40,
    ExpandConstant('{cm:BtnNext}'), clWhite, @NextClicked, BtnNext, BtnNextText);
  MakeImageButton(WizardForm, 'btn-ghost-back.bmp', {#WinW} - 132 - 34 - 110 - 10, {#WinH} - 70, 110, 40,
    ExpandConstant('{cm:BtnBack}'), CLR_BTN_TEXT, @BackClicked, BtnBack, BtnBackText);
  MakeImageButton(WizardForm, 'btn-ghost-cancel.bmp', 34, {#WinH} - 70, 110, 40,
    ExpandConstant('{cm:BtnCancel}'), CLR_BTN_TEXT, @CancelClicked, BtnCancel, BtnCancelText);

  RefreshUi();
end;

var
  IconApplied: Boolean;

procedure CurPageChanged(CurPageID: Integer);
begin
  // 任务栏按钮的图标是在窗口**显示那一刻**取的：初始化时设太早，任务栏可能已经抓过默认图标。
  // 所以窗口真正出来后（第一次切页）再设一次。
  if not IconApplied then
  begin
    IconApplied := True;
    SetWindowIcon();
  end;
  RefreshUi();
end;

procedure DeinitializeSetup();
begin
  UnloadUiFont();
end;

{ 安装进度：把 Inno 的文件行文字抄到透明标签，并按比例伸出自绘进度条 }
procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  W: Integer;
begin
  if not PathLabel.Visible then Exit;
  if MaxProgress > 0 then
    W := Round((({#ContentW} - 4) * CurProgress) / MaxProgress)
  else
    W := 0;
  if W < 0 then W := 0;
  if W > {#ContentW} - 4 then W := {#ContentW} - 4;
  // 进度条没有任何填充时，用户会以为"没在装"：给个最小可见宽度
  if (W = 0) and (MaxProgress > 0) then W := 6;

  // 显示**完整路径**（Inno 的 FilenameLabel 只有文件名，这里补上安装目录）：
  //   39%   D:\Application\ds-pet\locales\zh-CN.pak
  if MaxProgress > 0 then
    PathLabel.Caption := IntToStr(Round((100 * CurProgress) / MaxProgress)) + '%   ' +
      ExpandConstant('{app}\') + WizardForm.FilenameLabel.Caption
  else
    PathLabel.Caption := ExpandConstant('{app}\') + WizardForm.FilenameLabel.Caption;

  ProgressFill.SetBounds({#ContentX} + 2, 140, W, 10);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // 跳过 Inno 的"准备安装"页（Preparing to install）：它只停留一两秒、文案是英文，
  // 而且我们的背景图里没有它 —— 直接进"正在安装"更干净。
  Result := PageID = wpPreparing;
end;
