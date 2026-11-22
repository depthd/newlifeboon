"""Render visual checks from audit JSON: python3 tools/contact-audit-figures.py evidence/contacts."""
import argparse
import json
from pathlib import Path
import math
import os
import tempfile

os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'vehicle-audit-matplotlib'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--after', default='final.json')
args = parser.parse_args()
out = args.directory
before, after = (json.loads((out / f).read_text()) for f in ['baseline.json', args.after])
by_key = lambda data: {(r['car'], r['scenario'], r['hz']): r for r in data['rows']}
base, final = map(by_key, [before, after])
colors = ['#B45132', '#146C80']
car_names = {'viper': 'Dodge Viper', 'логан': 'Renault Logan'}

# Shared units, fixed axes, directly measured COM height.
fig, axes = plt.subplots(1, 2, figsize=(11.4, 5.2), sharex=True, sharey=True)
for ax, (code, title) in zip(axes, car_names.items()):
    for source, color, label in zip([base, final], colors, ['До', 'После']):
        trace = source[code, 'edge-right', 600]['trace']
        ax.plot([v[0] for v in trace], [v[2]-trace[0][2] for v in trace], color=color, label=label, lw=2.8)
    ax.axhline(0, lw=1, color='#687783')
    ax.grid(alpha=.18)
    ax.set_title(title, loc='left', fontweight='bold')
    ax.set_xlabel('Время после снятия опоры, с')
    ax.spines[['right', 'top']].set_visible(False)
axes[0].set_ylabel('Высота центра масс относительно старта, м')
axes[1].legend(frameon=False)
fig.suptitle('Под правыми колёсами исчезает дорога', fontsize=18, fontweight='bold', x=.08, ha='left')
fig.text(.08,.025,'Машины стояли без газа. График показывает первые две секунды падения на шаге 1/600 с.',fontsize=10)
fig.subplots_adjust(left=.085,bottom=.18,top=.82,wspace=.13)
fig.savefig(out/'edge-height.png', dpi=145)
plt.close(fig)

# Visualise the sampled front projection. Body corners and wheel centres have been
# captured by the physics loop; labels show original (unshifted) world height.
font_path = matplotlib.font_manager.findfont('DejaVu Sans')
bold_path = matplotlib.font_manager.findfont(matplotlib.font_manager.FontProperties(family='DejaVu Sans', weight='bold'))
def font(size,bold=False): return ImageFont.truetype(bold_path if bold else font_path, size)
def hull(points):
    points = sorted(set(points))
    if len(points)<3: return points
    def cross(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    lower, upper = [], []
    for p in points:
        while len(lower)>=2 and cross(lower[-2],lower[-1],p)<=0: lower.pop()
        lower.append(p)
    for p in reversed(points):
        while len(upper)>=2 and cross(upper[-2],upper[-1],p)<=0: upper.pop()
        upper.append(p)
    return lower[:-1]+upper[:-1]

frames=[]
samples=[d['логан','edge-right',600]['trace'] for d in (base,final)]
for i in range(0,len(samples[0])):
    image=Image.new('RGB',(928,450),'#F3F3EF')
    draw=ImageDraw.Draw(image)
    draw.text((20,14),'Logan на краю дороги',fill='#142730',font=font(24, True))
    draw.text((20,47),'Вид сзади, по координатам симуляции. На нулевой секунде исчезает правая опора.',fill='#3B4D55',font=font(16))
    for j,(trace,color,label) in enumerate(zip(samples,colors,['До','После'])):
        t,x,y,z,vy,roll,*rest=trace[i]
        points=rest[-1]
        left=20+450*j
        draw.text((left,84),label,fill=color,font=font(20,True))
        draw.text((left+94,85),'Высота от старта  %+.2f м' % (y-trace[0][2]),fill='#293E45',font=font(16))
        pane=Image.new('RGB',(436,255),'#FBFBF8'); pd=ImageDraw.Draw(pane)
        scale=57; cy=min(max(y-.45, -100),100)
        # Camera follows the car vertically. Pixel scale and world coordinates are the same in both views.
        def pix(zp,yp):return (round(160+(zp-z*.65)*scale),round(156-(yp-cy)*scale))
        for h in range(math.floor(cy-2),math.ceil(cy+3)):
            py=pix(0,h)[1]
            pd.line((0,py,436,py),fill='#DFE4E0',width=1)
            pd.text((5,py+2),str(h)+' м',fill='#8A9696',font=font(11))
        edge_x, edge_y=pix(0,0)
        if edge_x>0 and edge_y<255:
            pd.rectangle((0,max(edge_y,0),edge_x,255),fill='#B5BDB7')
            pd.line((0,edge_y,edge_x,edge_y),fill='#3F5050',width=3)
            pd.line((edge_x,max(0,edge_y),edge_x,255),fill='#697778',width=2)
        body=hull([pix(*loc) for loc in points[:8]])
        if len(body)>=3: pd.polygon(body,fill=color,outline='#263D44',width=2)
        for wheel in points[8:]:
            wx,wy=pix(*wheel); pd.ellipse((wx-4,wy-4,wx+4,wy+4),fill='#E9FFFF',outline='#25393B',width=2)
        cx,yy=pix(z,y); pd.ellipse((cx-4,yy-4,cx+4,yy+4),fill='#FFE9A0',outline='#27383D',width=1)
        image.paste(pane,(left,116))
    draw.text((20,385),'Время   %.2f с' % t,fill='#182D35',font=font(17,True))
    draw.text((195,386),'Камеры следуют по высоте. Светлые точки — центры колёс.',fill='#3B4D55',font=font(15))
    draw.line((20,432,906,432),fill='#D8DFDB',width=4)
    draw.line((20,432,20+886*t/2,432),fill='#146C80',width=4)
    frames.append(image)
frames[-1].save(out/'edge-frame.png')
frames[0].save(out/'edge-replay.gif',save_all=True,append_images=frames[1:],duration=[80]*(len(frames)-1)+[1300],loop=0, optimize=True)

fig, axes = plt.subplots(1, 2, figsize=(11.4, 4.9))
ax=axes[0]
for code, name in car_names.items():
    for data, style, version in [(base,'--','до'),(final,'-','после')]:
        series = data[code,'slope-held',600]['trace']
        ax.plot([v[0] for v in series], [-100*v[1] for v in series],
                linestyle=style,color=colors[0 if code=='viper' else 1],label=name.split()[-1]+' · '+version, lw=2)
ax.axhline(5, color='#747879', linewidth=1, linestyle=':',label='Допуск 5 см')
ax.set(xlabel='Секунды с затянутым ручником',ylabel='Откат, см',title='Удержание на подъёме 10%')
ax.legend(frameon=False,fontsize=9)
ax=axes[1]
labels=['Асфальт','Левый борт на асфальте','Трава']
for i,(code,name) in enumerate(car_names.items()):
    values=[final[code,'braking-'+surface,600]['metrics']['stop_path_m'] for surface in ['asphalt','mixed','grass']]
    bars=ax.barh([j+.20*(i*2-1) for j in range(3)],values,height=.36,color=colors[i],label=name.split()[-1])
    ax.bar_label(bars,fmt='%.1f м',padding=2,fontsize=9)
ax.set(xlabel='Пройденное расстояние, м',title='Торможение с 60 до 3,6 км/ч')
ax.set_yticks(range(3),labels)
ax.set_xlim(0,max(final[k,'braking-grass',600]['metrics']['stop_path_m'] for k in car_names)*1.23)
ax.invert_yaxis()
ax.legend(frameon=False,fontsize=9)
for ax in axes:
    ax.grid(axis='x',alpha=.15)
    ax.spines[['right','top']].set_visible(False)
fig.suptitle('Удержание и сцепление', fontsize=18,fontweight='bold',x=.09,ha='left')
fig.subplots_adjust(left=.08,right=.97,bottom=.16,top=.83,wspace=.60)
fig.savefig(out/'parking-braking.png',dpi=145)
plt.close(fig)
