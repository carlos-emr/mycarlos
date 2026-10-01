param([Parameter(Mandatory)][int]$AppPid, [Parameter(Mandatory)][string]$Title,
      [Parameter(Mandatory)][string]$Action, [string]$Value = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeDialogInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Key(IntPtr window, uint pid, ushort key) {
    uint actual; GetWindowThreadProcessId(window, out actual);
    if (actual != pid || GetForegroundWindow() != window) throw new Exception("Dialog lost foreground or ownership before keypress");
    var inputs = new INPUT[2];
    inputs[0].type=inputs[1].type=1;
    inputs[0].data.keyboard.key=inputs[1].data.keyboard.key=key;
    inputs[1].data.keyboard.flags=2;
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }
}
'@
$UI = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$condition = [System.Windows.Automation.PropertyCondition]::new($UI::ProcessIdProperty, $AppPid)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = $UI::RootElement.FindAll($scope::Children, $condition)
  foreach ($window in $windows) {
    $name = $window.Current.Name
    $matches = if ($Title -eq 'FILE_SAVE') { $name -eq 'Save As' } elseif ($Title -eq 'FILE_OPEN') { $name -eq 'Open' } else { $name -eq $Title }
    if ($matches) { $dialog = $window; break }
  }
  if ($null -ne $dialog) { break }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $dialog) { throw "Native dialog not found: $Title" }
$hwnd = [IntPtr]$dialog.Current.NativeWindowHandle
[uint32]$ownerPid = 0
[void][NativeDialogInput]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ($ownerPid -ne $AppPid) { throw 'Wrong native dialog owner' }
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new($UI::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$buttons = $dialog.FindAll($scope::Descendants, $buttonCondition)
$beforeFocus = $UI::FocusedElement.Current.Name
# Activate only the dialog window; never move focus to a particular button.
[void][NativeDialogInput]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 100
if ([NativeDialogInput]::GetForegroundWindow() -ne $hwnd) { throw 'Could not foreground the owned dialog' }
$focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
$focusOwned = $false
while ([DateTime]::UtcNow -lt $focusDeadline) {
  $focus = $UI::FocusedElement
  $ancestor = $focus
  while ($null -ne $ancestor) {
    if ([System.Windows.Automation.Automation]::Compare($ancestor, $dialog)) { $focusOwned = $true; break }
    $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
  }
  if ($focusOwned) { break }
  Start-Sleep -Milliseconds 50
}
if (!$focusOwned) { throw 'Keyboard focus is outside the owned dialog' }
$evidence = @{title=$dialog.Current.Name; action=$Action; buttons=@($buttons | ForEach-Object { $_.Current.Name }); beforeActivationFocus=$beforeFocus; focus=$focus.Current.Name; focusType=$focus.Current.ControlType.ProgrammaticName}
switch ($Action) {
  'enter' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x0D) }
  'space' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x20) }
  'escape' { [NativeDialogInput]::Key($hwnd, $AppPid, 0x1B) }
  'close' { if (![NativeDialogInput]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'WM_CLOSE failed' } }
  'button' {
    $matching = @($buttons | Where-Object { $_.Current.Name -eq $Value })
    if ($matching.Count -ne 1) { throw "Expected one button named $Value; found $($matching.Count)" }
    ([System.Windows.Automation.InvokePattern]$matching[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  'file' {
    $editCondition = [System.Windows.Automation.PropertyCondition]::new($UI::AutomationIdProperty, '1001')
    $edit = $dialog.FindFirst($scope::Descendants, $editCondition)
    if ($null -eq $edit) { throw 'File name edit was not found' }
    ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($Value)
    $label = if ($Title -eq 'FILE_SAVE') { 'Save' } else { 'Open' }
    $matching = @($buttons | Where-Object { $_.Current.Name.Replace('&','') -eq $label })
    if ($matching.Count -ne 1) { throw "Expected one file picker $label button" }
    ([System.Windows.Automation.InvokePattern]$matching[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  default { throw "Unknown native action: $Action" }
}
$evidence | ConvertTo-Json -Compress -Depth 5
