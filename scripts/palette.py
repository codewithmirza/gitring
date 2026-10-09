import math, itertools
def oklch_to_srgb(L, C, h):
    L = L/100 if L>1 else L
    a = C*math.cos(math.radians(h)); b = C*math.sin(math.radians(h))
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    def gam(x):
        x = min(max(x,0),1)
        return 12.92*x if x <= 0.0031308 else 1.055*x**(1/2.4)-0.055
    return tuple(gam(v) for v in (r,g,bb)), (r,g,bb)
def lum(rgb):
    def lin(c): return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
    r,g,b = (lin(c) for c in rgb)
    return 0.2126*r+0.7152*g+0.0722*b
def hexs(rgb): return '#'+''.join(f'{round(c*255):02x}' for c in rgb)
def cr(c1,c2):
    l1,l2 = lum(c1),lum(c2)
    hi,lo = max(l1,l2),min(l1,l2)
    return (hi+0.05)/(lo+0.05)
def inGamut(lin): return all(-0.0005<=v<=1.0005 for v in lin)
themes = {
 'day': dict(bg=(98.6,0.004,230), s1=(96.6,0.006,232), s2=(93.6,0.009,234), line=(86,0.012,236), lineS=(72,0.016,240),
            ink3=(50,0.02,248), ink2=(39,0.022,252), ink1=(24,0.026,256), land=(93.2,0.034,84), landEdge=(80,0.05,80), shoal=(92.5,0.03,226),
            accent=(49,0.13,236), magenta=(51,0.2,348), clear=(50,0.11,165), danger=(53,0.19,29), caution=(48,0.11,72), cautionFill=(80,0.14,82)),
 'dusk': dict(bg=(30,0.018,246), s1=(33.5,0.02,246), s2=(37,0.022,246), line=(44,0.022,246), lineS=(54,0.024,246),
            ink3=(70,0.018,242), ink2=(82,0.014,240), ink1=(94,0.008,236), land=(39,0.03,82), landEdge=(50,0.04,80), shoal=(36,0.035,228),
            accent=(76,0.11,232), magenta=(75,0.15,348), clear=(78,0.11,165), danger=(74,0.14,29), caution=(82,0.12,80), cautionFill=(70,0.13,78)),
 'night': dict(bg=(16.5,0.018,252), s1=(20,0.02,252), s2=(23.5,0.022,252), line=(31,0.022,252), lineS=(41,0.024,250),
            ink3=(66,0.018,244), ink2=(79,0.014,240), ink1=(92,0.008,236), land=(26.5,0.026,82), landEdge=(36,0.035,80), shoal=(24,0.035,230),
            accent=(74,0.11,232), magenta=(72,0.15,348), clear=(76,0.11,165), danger=(70,0.15,29), caution=(80,0.12,80), cautionFill=(66,0.13,78)),
}
for t, pal in themes.items():
    print('==', t)
    rgbs = {k: oklch_to_srgb(*v) for k,v in pal.items()}
    for k,(rgb,lin) in rgbs.items():
        print(f'  {k:10s} {hexs(rgb)} gamut={"ok" if inGamut(lin) else "OUT"}')
    for fg in ['ink1','ink2','ink3','accent','magenta','clear','danger','caution']:
        for bgk in ['bg','s1','s2','land']:
            print(f'    {fg:8s} on {bgk:5s}: {cr(rgbs[fg][0], rgbs[bgk][0]):.2f}', end='')
        print()
    print('    lineS vs bg (non-text 3:1):', round(cr(rgbs['lineS'][0], rgbs['bg'][0]),2), ' landEdge vs land:', round(cr(rgbs['landEdge'][0], rgbs['land'][0]),2), ' land vs bg:', round(cr(rgbs['land'][0], rgbs['bg'][0]),2))
