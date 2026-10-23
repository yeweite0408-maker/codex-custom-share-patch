"""Place the background controls in the native Appearance settings page."""
from patch_usage_footer import once


def patch_appearance(source):
    return once(source,
        'children:(0,h.jsx)(u,{defaultAdvancedExpanded:i},r)',
        'children:(0,h.jsxs)(h.Fragment,{children:[(0,h.jsx)(u,{defaultAdvancedExpanded:i},r),(0,h.jsx)(`codex-wallpaper-settings`,{})]})')
