"""Regenerate synthetic OCR fixtures only; never seeds the application."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

directory = Path(__file__).resolve().parents[2] / "tests" / "ocr-fixtures"
directory.mkdir(exist_ok=True)
font = ImageFont.truetype(
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 148
)
for name, text in (("mercosul", "ABC1D23"), ("legacy", "ABC1234")):
    image = Image.new("RGB", (1100, 280), "white")
    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((1100 - (box[2] - box[0])) // 2,
         (280 - (box[3] - box[1])) // 2 - box[1]),
        text, font=font, fill="black"
    )
    image.save(directory / f"{name}.png")
