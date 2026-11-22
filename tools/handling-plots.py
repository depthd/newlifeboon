"""Render simulator measurements. python tools/handling-plots.py <handling output>"""
import argparse
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("--animation", action="store_true", help="Render a side-by-side video of the two grip experiments")
args = parser.parse_args()
directory = args.directory
report = json.loads((directory / "handling.json").read_text())
blue, orange, green, grey = "#23679c", "#bc4e1c", "#267858", "#5e6571"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10,
    "axes.spines.top": False, "axes.spines.right": False, "axes.labelcolor": "#273341",
    "axes.grid": True, "grid.alpha": 0.18, "figure.facecolor": "white",
    "axes.axisbelow": True, "savefig.dpi": 155,
})


def trace(name):
    with (directory / (name + ".csv")).open() as handle:
        rows = list(csv.DictReader(handle))
    return {k: np.array([float(r[k]) for r in rows]) for k in rows[0]}


def save(fig, filename):
    fig.savefig(directory / filename, bbox_inches="tight", pad_inches=0.23)
    plt.close(fig)


def xy(ax):
    ax.set_aspect("equal", adjustable="datalim")
    ax.set_xlabel("Вперёд от старта, м")
    ax.set_ylabel("Вправо, м")


models = [("logan", "Logan", blue), ("viper", "Viper", orange)]
fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), constrained_layout=True)
fig.suptitle("Один поворот при 66 км/ч — три действия педалью", fontsize=16, weight="bold")
for ax, (key, title, _) in zip(axes, models):
    for mode, label, colour, linestyle in [
        ("early", "Ранний газ", orange, "-"),
        ("late", "Поздний газ", blue, "--"),
        ("lift", "Ранний газ и сброс", green, ":")
    ]:
        q = trace(key + "-corner-" + mode)
        ax.plot(q["x_m"], q["z_m"], linestyle, c=colour, lw=2.6, label=label)
        start = np.flatnonzero(q["gas"] > 0)
        ax.scatter(q["x_m"][start[0]], q["z_m"][start[0]], s=27, c=colour, zorder=3)
        ax.scatter(q["x_m"][-1], q["z_m"][-1], s=23, marker="x", c=colour)
    brake = np.flatnonzero(q["brake"] > 0)[0]
    ax.scatter(q["x_m"][brake], q["z_m"][brake], s=23, c="#3b4558", marker="s", zorder=4)
    ax.annotate("тормоз", (q["x_m"][brake], q["z_m"][brake]),
                xytext=(2, 11), textcoords="offset points", fontsize=8, color=grey)
    ax.set_title(title)
    xy(ax)
    ax.legend(loc="upper left", frameon=False, fontsize=9)
fig.text(0.5, -0.035, "Точка — первое нажатие газа. Крест — положение через пять секунд. Руль одинаков во всех трёх проездах.",
         ha="center", color=grey)
save(fig, "corner-trajectories.png")

fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), constrained_layout=True)
fig.suptitle("Какую ось первой лишили части сцепления", fontsize=16, weight="bold")
for ax, (key, title, _) in zip(axes, models):
    for profile, colour, linestyle, label in [
        ("a-", blue, "--", "Передняя ось −40%"),
        ("b-", orange, "-.", "Задняя ось −40%"),
        ("", "#323943", "-", "Базовая машина")
    ]:
        q = trace(key + "-" + profile + "corner-early")
        ax.plot(q["x_m"], q["z_m"], linestyle, c=colour, lw=2.2, label=label)
        ax.scatter(q["x_m"][-1], q["z_m"][-1], s=24, marker="x", c=colour)
    ax.set_title(title)
    xy(ax)
    ax.legend(loc="upper left", frameon=False, fontsize=9)
fig.text(0.5, -0.035, "Все три следа начинаются с одного места. Газ и поворот руля одинаковы. Крест обозначает конец записи.",
         ha="center", color=grey)
save(fig, "balance-trajectories.png")

fig, axes = plt.subplots(1, 2, figsize=(11, 4.3), constrained_layout=True,
                         gridspec_kw={"width_ratios": [0.82, 1.25]})
ax, graph = axes
fig.suptitle("Круг испытательной трассы — одни команды водителя", fontsize=15, weight="bold")
for key, title, colour in models:
    q = trace(key+"-lap")
    metrics = next(r["lap"] for r in report["results"] if r["key"] == key)
    ax.plot(q["x_m"], q["z_m"], c=colour, lw=2, alpha=0.8, label=title)
    graph.plot(q["progress_m"], q["speed_kmh"], c=colour, lw=2, label=f"{title}  {metrics['lapS']:.2f} с")
ax.scatter([0], [0], c=grey, s=30, zorder=3)
ax.annotate("старт →", (0, 0), xytext=(0, -15), textcoords="offset points", fontsize=9)
ax.set(xlabel="Вперёд от старта, м", ylabel="Вправо, м", aspect="equal", title="478,8 м по осевой линии")
cuts = [0, 120, 120 + np.pi*38, 240 + np.pi*38, 240 + 2*np.pi*38]
for start, stop in [(cuts[1], cuts[2]), (cuts[3], cuts[4])]:
    graph.axvspan(start, stop, alpha=0.12, color=grey)
graph.set(xlabel="Расстояние по трассе, м", ylabel="Скорость, км/ч", title="Серым выделены повороты")
graph.legend(frameon=False, loc="upper right")
fig.text(0.5, -0.045, "Заданный темп в поворотах — 54 км/ч. На прямых водитель разгоняется и тормозит по общей программе.",
         ha="center", color=grey)
save(fig,"lap-sectors.png")

fig, axes = plt.subplots(1,2,figsize=(11,4.4), constrained_layout=True)
fig.suptitle("Удержание круга диаметром 91,44 м и переставка",fontsize=15,weight="bold")
circle, lane = axes
for key, title, colour in models:
    r = next(v for v in report["results"] if v["key"] == key)
    q = trace(key+"-circle-right")
    angle = np.degrees(np.unwrap(np.arctan2(q["x_m"],45.72-q["z_m"])))
    circle.plot(angle-angle[0],q["radial_error_m"],c=colour,lw=2,label=f"{title}  {r['circle']['g']:.3f} g")
    q = trace(key+"-lane")
    lane.plot(q["x_m"],q["z_m"],c=colour,lw=2,label=title)
lane.plot(q["x_m"],q["target_z_m"],"--",c="#31383f",lw=1.4,label="Заданная линия")
lane.set(xlabel="Вперёд от старта, м",ylabel="Смещение вправо, м", title="Переход в соседнюю полосу и обратно")
circle.axhspan(-0.75,0.75,color=green,alpha=0.07)
circle.axhline(0.75,c=grey,lw=1,ls=":")
circle.axhline(-0.75,c=grey,lw=1,ls=":")
circle.set(xlabel="Пройденная дуга, градусы",ylabel="Ошибка радиуса, м",ylim=(-0.9,0.9),title="Самый быстрый зачётный круг вправо")
circle.legend(frameon=False); lane.legend(frameon=False)
fig.text(0.5,-0.035,"На круге допустима ошибка радиуса до 0,75 м. Переставка выполнена при целевой скорости 60 км/ч.",
         ha="center", color=grey)
save(fig,"circle-and-lane.png")

fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), constrained_layout=True)
fig.suptitle("Что меняет помощь рулю при раннем газе", fontsize=15, weight="bold")
for ax, (key, title, _) in zip(axes, models):
    for part, label, colour, linestyle in [
        ("", "Водитель", blue, "--"),
        ("assist-", "Водитель с помощью", orange, "-")
    ]:
        q = trace(key + "-" + part + "corner-early")
        ax.plot(q["t_s"], q["steer_road_deg"], linestyle, c=colour, lw=2.3, label=label)
    ax.axvline(1.3, lw=1, color=grey, ls=":")
    ax.axhline(0, lw=0.8, color=grey)
    ax.set(xlabel="Время, с", ylabel="Угол передних колёс, °", title=title)
    ax.legend(frameon=False)
fig.text(0.5, -0.035,
         "Одинаковая команда руля. Пунктирная вертикаль — водитель добавил газ. Отрицательный угол означает контрруление.",
         ha="center", color=grey)
save(fig,"steering-assist.png")


fig, (skid, brake) = plt.subplots(1, 2, figsize=(11, 3.7), constrained_layout=True)
fig.suptitle("Viper и инструментальные испытания Car and Driver", fontsize=15, weight="bold")
viper = next(r for r in report["results"] if r["key"] == "viper")
for ax, target, band, names, values, unit, title in [
    (skid, 1.02, 0.06, ["Журнал", "Плавный разгон", "Сразу на скорости"],
     [1.02, viper["circle"]["g"], viper["flyingStartCircle"]["g"]], "g", "Круг диаметром 300 футов"),
    (brake, 44.5008, 44.5008*0.07, ["Журнал", "Модель"],
     [44.5008, viper["braking70"]["distanceM"]], "м", "Торможение с 70 миль/ч")
]:
    ax.axvspan(target-band, target+band, color=green, alpha=0.13)
    ax.axvline(target, color=grey, lw=1, ls=":")
    for k, (name,value) in enumerate(zip(names,values)):
        ax.scatter(value, -k, s=54, marker="s" if k==0 else "o", color=grey if k==0 else blue, zorder=3)
        ax.annotate(f"{value:.3f} g" if unit=="g" else f"{value:.2f} м", (value,-k),
                    xytext=(0,9), textcoords="offset points", ha="center", fontsize=9)
    ax.set_yticks(-np.arange(len(names)),names)
    margin = band * 0.72
    ax.set(xlim=(min(target-band,*values)-margin,max(target+band,*values)+margin),
           ylim=(-len(names)+0.65,0.65), title=title, xlabel=unit)
fig.text(0.5, -0.045,
         "Зелёная полоса — принятый в проекте допуск. Источник — сравнительный тест SRT Viper GTS и Corvette ZR1, 2013.",
         ha="center", color=grey)
save(fig, "viper-independent-measurements.png")


if args.animation:
    from matplotlib.animation import FFMpegWriter
    from matplotlib.patches import Polygon

    fig, axes = plt.subplots(2, 2, figsize=(10.8, 6.6), constrained_layout=True)
    header = fig.suptitle("", fontsize=15, weight="bold")
    panels = []
    for (key, title, _), row in zip(models, axes):
        for ax, part, axle, colour in zip(row, ["a", "b"], ["передней", "задней"], [blue, orange]):
            q = trace(f"{key}-{part}-corner-early")
            ax.set(xlim=(-5, 103), ylim=(-8, 62), aspect="equal",
                   title=f"{title} · меньше сцепления на {axle} оси")
            ax.set_xlabel("Вперёд, м", fontsize=8)
            ax.set_ylabel("Вправо, м", fontsize=8)
            ax.tick_params(labelsize=8)
            line, = ax.plot([], [], lw=2, color=colour)
            body = Polygon([[0, 0], [0, 0], [0, 0]], closed=True,
                           facecolor=colour, edgecolor="white", lw=0.9, zorder=3)
            ax.add_patch(body)
            annotation = ax.text(0.025, 0.95, "", transform=ax.transAxes, va="top", fontsize=9)
            panels.append((q, line, body, annotation))
    fig.text(0.5, -0.025, "Педали и руль у всех одинаковы. Острый конец фигуры — нос машины, след — путь её центра.",
             ha="center", color=grey)
    shape = np.array([[5.5, 0], [2.1, 1.7], [-3.0, 1.7], [-3.0, -1.7], [2.1, -1.7]])
    with FFMpegWriter(fps=12, codec="libx264", extra_args=["-pix_fmt", "yuv420p", "-crf", "23"]).saving(
            fig, str(directory / "balance-replay.mp4"), dpi=120) as writer:
        # Equal simulated time in all four panels, played at half speed.
        indices = np.linspace(0, len(panels[0][0]["x_m"])-1, 120).round().astype(int)
        for j in list(indices) + [indices[-1]]*12:
            time = panels[0][0]["t_s"][j]
            header.set_text(f"Задание на поворот    {time:.2f} с")
            for data, line, body, annotation in panels:
                x, z, yaw = data["x_m"][j], data["z_m"][j], np.radians(data["yaw_deg"][j])
                line.set_data(data["x_m"][:j+1], data["z_m"][:j+1])
                rotation = np.array([[np.cos(yaw), np.sin(yaw)], [-np.sin(yaw), np.cos(yaw)]])
                body.set_xy(shape @ rotation + [x, z])
                annotation.set_text(f'{data["speed_kmh"][j]:.0f} км/ч · угол между носом и движением {abs(data["sideslip_deg"][j]):.0f}°')
            writer.grab_frame()
    plt.close(fig)
