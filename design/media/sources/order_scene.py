"""Original JK process illustration; ManimGX 0.1.1. No customer or brand assets."""
import manimgx as m

m.config.background_color = "#F5F7F9"
INK = "#1C3041"
MUTED = "#5F6F7F"
ACCENT = "#3B63FB"
LINE = "#CCD8E2"


class OrderFlow(m.Scene):
    def construct(self):
        xs = [-4.5, -1.5, 1.5, 4.5]
        names = ["Aguardando", "Em serviço", "Conferência", "Pronta"]
        labels = m.VGroup()
        boxes = []
        for x, name in zip(xs, names):
            box = m.RoundedRectangle(width=2.6, height=1.05, corner_radius=0.12,
                                     stroke_color=LINE, stroke_width=2,
                                     fill_color="#FFFFFF", fill_opacity=1).move_to([x, -0.6, 0])
            label = m.Text(name, font="Noto Sans", font_size=24, color=INK).move_to([x, -0.6, 0])
            boxes.append(box)
            labels.add(box, label)
        road = m.Line([-5.7, 0.3, 0], [5.7, 0.3, 0], color=LINE, stroke_width=2)
        body = m.RoundedRectangle(width=1.1, height=0.38, corner_radius=0.10,
                                  fill_color=ACCENT, fill_opacity=1, stroke_width=0)
        roof = m.RoundedRectangle(width=0.58, height=0.32, corner_radius=0.08,
                                  fill_color=ACCENT, fill_opacity=1, stroke_width=0).shift([0, 0.22, 0])
        wheels = m.VGroup(m.Circle(radius=0.10, fill_color=INK, fill_opacity=1, stroke_width=0).shift([-0.34,-0.2,0]),
                          m.Circle(radius=0.10, fill_color=INK, fill_opacity=1, stroke_width=0).shift([0.34,-0.2,0]))
        car = m.VGroup(body, roof, wheels).move_to([xs[0], 0.9, 0])
        correction = m.Text("Se precisar, volta ao serviço.", font="Noto Sans", font_size=28, color=MUTED).move_to([0,-2.0,0])
        self.add(road, labels, car)
        self.wait(0.5)
        self.play(car.animate.move_to([xs[1],0.9,0]), run_time=1.2)
        self.play(car.animate.move_to([xs[2],0.9,0]), run_time=1.2)
        self.play(m.FadeIn(correction), run_time=0.4)
        self.play(car.animate.move_to([xs[1],0.9,0]), run_time=1.0)
        self.wait(0.4)
        self.play(m.FadeOut(correction), car.animate.move_to([xs[2],0.9,0]), run_time=1.0)
        self.play(car.animate.move_to([xs[3],0.9,0]), run_time=1.2)
        self.wait(1.1)
