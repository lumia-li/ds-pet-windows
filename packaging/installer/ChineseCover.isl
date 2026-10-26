; ds-pet 安装程序的中文覆盖层。
;
; 只覆盖 [LangOptions]（语言/字体）与常用 [Messages]：
; 通过 "compiler:Default.isl,ChineseCover.isl" 两个文件叠加，没写的消息仍用 Default.isl。
; 关键是 LanguageID = $0804（简体中文）：Inno 会把**进程 UI 语言**切到中文，
; 于是 Windows 系统对话框（选文件夹那个 Browse For Folder）也跟着显示中文按钮。

[LangOptions]
LanguageName=简体中文
LanguageID=$0804
LanguageCodePage=936
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
WelcomeFontName=Microsoft YaHei UI
WelcomeFontSize=12
TitleFontName=Microsoft YaHei UI
TitleFontSize=29
CopyrightFontName=Microsoft YaHei UI
CopyrightFontSize=8

[Messages]
SetupAppTitle=安装程序
SetupWindowTitle=ds-pet 安装程序
UninstallAppTitle=卸载
UninstallAppFullTitle=卸载 ds-pet
ButtonBack=< 上一步(&B)
ButtonNext=下一步(&N) >
ButtonInstall=安装(&I)
ButtonOK=确定
ButtonCancel=取消
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonFinish=完成(&F)
ExitSetupTitle=退出安装
ExitSetupMessage=安装还没完成，现在退出的话 ds-pet 不会被安装。%n%n确定退出吗？
BrowseDialogTitle=选择文件夹
BrowseDialogLabel=在下面选择一个文件夹，然后点确定。
BrowseDialogInvalidPath=路径无效。请重新选择。
