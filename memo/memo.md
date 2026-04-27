# 再生/一時停止ボタン、コマ送り/コマ戻しボタンの実装
## prompt for GPT 5.5 medium
このプロジェクトはゲームなどをキャプチャした動画から、前後2フレームが同一かを判定することでfpsを推定するアプリです。概要は`src\App.tsx`を見るとわかります。importした動画をリアルタイムに再生しながらfpsやフレームタイムが表示されます。追加の機能として動画をリアルタイムに再生している部分に、動画プレイヤーのように再生/一時停止ボタンと、前後1フレームだけシークするコマ送り/コマ戻しのボタンを追加してください。見た目にこだわってスタイリングのコードが増えないように注意してください。装飾はいりません。再生/一時停止ボタン、コマ送り/コマ戻しボタンはSVGアイコン等を利用してください。
## 結果
`onClick={stepBackward}`がうまく動かない。具体的には0フレームから2フレームしか巻き戻らない。`onClick={togglePlayback}`のみ操作したときうまく動き、フレームタイムグラフも1フレーム分進む。`onClick={stepBackward}`と`onClick={togglePlayback}`を交互にクリックすると、想定ではフレームタイムのグラフもクリックするたびに交互に前と後に動くところ、`onClick={stepBackward}`で後ろに戻らずに前にしか進まない。[フレームタイムグラフバグ](./stepBackward-frametimeHistoryBug.png)のようになる。
## 考えたこと
フレームタイムのグラフは`player.ts`の`processFrame`関数の`this.pushHistory({ image: snapshotImage, stats });`で更新される。`processFrame`関数の使用先をたどると、大本は`App.tsx`の`const start = async () => {...}`によって呼ばれる。`onClick={stepBackward}`を押したとき、(中略、後で書く)`processFrame`は実行されず、`player.ts`の`feedDecoder`関数の
```TypeScript
while (
        this.decoder.decodeQueueSize > 30 ||
        this.outstandingFrames > MAX_OUTSTANDING_FRAMES
      ) {
        await new Promise((r) => setTimeout(r, 5));
        if (this.stopped) return;
      }
```
のループで処理が終わってしまう(これで終わるのは`onClick={stepBackward}`も同様)。
