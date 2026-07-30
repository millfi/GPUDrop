# GPUDrop

ゲームキャプチャ動画のFPSを推定するアプリ。連続する2フレームをWebGPUシェーダで比較し、同一フレームを検出することで実効FPSを算出します。

## 概要

- **リアルタイム動作**: Mediabunnyによるハードウェアデコード+WebGPUによる高速比較
- **比較**: WebGPU compute shader で同一座標のピクセルを比較し、linearRGB空間でのユークリッド距離が閾値を超えたピクセル数を数える
- **同一フレーム判定**: 閾値超過ピクセル数が閾値割合を超えると重複フレーム(フレームドロップ発生)と判定
- **FPS**: 直近1秒間のユニークフレーム数を視覚化

## 使い方
[GPUDrop](https://millfi.github.io/GPUDrop/)にアクセス
## build & run
```shell
git clone https://github.com/millfi/GPUDrop.git
cd ./GPUDrop
npm install
npm run dev
```
を実行してnpmに案内されたlocalhostを開き、MP4ファイルを選択 → 閾値を調整 → 「開始」。

## 備考

SafariとFirefoxでは動かない可能性が高い。

## 操作

- **閾値**: 1ピクセルあたりのlinearRGB距離の許容値 (0〜0.5)。低圧縮の動画では小さく、強い圧縮では大きめに
- **差分パネル**: 閾値を超えたピクセルが赤で表示される
- **検知リスト**: 重複と判定されたフレームの動画内時刻 (秒、小数点以下3桁) と先頭からのフレーム番号
