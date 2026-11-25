# Fluxity — People in motion

ネイティブ **WebGPU / WGSL** と TypeScript で作った、リアルタイム3D群集シミュレーション。ゲームエンジン、3Dエンジン、WebGL、リモートの人物アセットは使用しません。

![Fluxity Shibuya Scramble](docs/screenshots/plateau-photo.jpg)

## 起動

Node.js **22.12以上**（または新しいLTS）を使用してください。

```sh
npm install
npm run dev
```

表示された `http://127.0.0.1:5173` を開きます。初期状態は **Shibuya Scramble / 1,000人 / seed 42 / 自動信号** です。

```sh
npm run typecheck  # strict TypeScript
npm test           # 数値・経路・メモリ境界のテスト
npm run build      # 型チェック + dist/ への本番ビルド
npm run preview    # ビルド結果をローカルで確認
npm run benchmark  # 広場のCPUシミュレーション性能測定
npm run benchmark:shibuya  # PLATEAU渋谷、青固定、1,000 / 5,000人
```

推奨環境は、ハードウェアアクセラレーションが有効なWindows/macOSの最新ChromeまたはEdgeです。WebGPUを実装した他のブラウザでも利用できます。`localhost` / `127.0.0.1` またはHTTPSのsecure contextが必要です。GPU・ドライバ・ブラウザのポリシーによって利用できない場合は、画面に原因と推奨環境を表示します。WebGLへの代替実装はありません。

## GitHub Pagesへの公開

このアプリは静的ファイルだけで動作し、バックエンドは不要です。`shuichi/fluxity` の標準の公開先は **https://shuichi.github.io/fluxity/** です。

1. リポジトリの [Settings → Pages](https://github.com/shuichi/fluxity/settings/pages) を開き、**Build and deployment → Source** を **GitHub Actions** にします。
2. [公開用ワークフロー](.github/workflows/deploy-pages.yml) を含む変更を `main` にコミット・pushします。

   ```sh
   git add .github/workflows/deploy-pages.yml README.md
   git commit -m "Add GitHub Pages deployment"
   git push origin main
   ```

3. [Actions](https://github.com/shuichi/fluxity/actions) の **Deploy to GitHub Pages** が成功したら、公開URLを開きます。ワークフローを先にpushした場合は、Pages設定後に **Run workflow** から `main` を選んで実行できます。

以後は `main` へのpushで自動更新します。Node.js 24で `npm ci` → `npm test` → `npm run build` を実行し、成功したときだけ `dist/` を公開します。`dist/` のコミットや、個人アクセストークン・追加Secretsの登録は不要です。

Viteの `base: './'` により、JavaScript・CSS・favicon・Workerを `/fluxity/` 配下から読み込めます。WebGPUにはHTTPSと対応ブラウザ・GPUが必要です。公開URLは `https://` で開いてください。SharedArrayBufferを使わないため、追加のCOOP / COEPヘッダー設定は不要です。

公開処理が失敗した場合はActionsの失敗したステップを確認してください。`Configure Pages` で失敗する場合はSourceが **GitHub Actions** になっているか、`Deploy to GitHub Pages` で権限エラーになる場合は `github-pages` 環境の保護ルールで `main` が許可されているかを確認します。

参考：[GitHub公式のカスタムワークフロー手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Viteの相対base設定](https://vite.dev/guide/build#relative-base)。

## 操作

- 左ドラッグ：カメラ回転。右ドラッグ：平行移動。ホイール：ズーム。
- 人物をクリックまたはタップすると、その人の目線で移動を追えます。`Esc`キーか画面右上の戻る矢印で、選択前のカメラ位置・向き・ズームに戻ります。
- カメラツールバー：Perspective / Overview / Street、視点リセット。`R`でもリセット。
- Pause / Resume、または `Space`：一時停止・再開。
- Reset：同じ設定・同じシードで再初期化。
- Population：1,000 / 5,000 / 10,000 / 20,000人。
- シナリオ：Shibuya Scramble、City Plaza、Bidirectional Corridor、Bottleneck、Crossing Flow。
- ShibuyaのBuilding appearance：**Photo / Solid**。PLATEAUの写真表示と単色表示を、歩行者の状態を維持したまま切り替えます。
- ShibuyaのPedestrian signal：**Auto / Green / Red**。青では横断を開始し、赤では新しい横断者が歩道で待機します。すでに横断している人は赤になっても渡り切ります。信号の変更で群集はリセットされません。
- 信号表示：現在の状態、次の自動切り替えまでのシミュレーション秒数、待機人数、横断人数。シミュレーション停止中でも手動で信号を変更できます。
- 自動信号は赤12秒・青35秒のデモ周期です。Autoへ戻すと現在のシミュレーション時刻の周期へ復帰します。
- Simulation speed、Walking speed、Avoidance：実行中に調整可能。
- Seed：再現可能な初期配置・外観・目的地選択。
- Quality：解像度とLODのプリセット。Debug：描画診断。
- 詳細統計：可視人数、LODごとの人数、Draw Call、三角形数、CPU描画準備時間、描画解像度。
- Benchmark：4つの人数を順に**2秒ウォームアップ＋4秒計測**。FPS、Frame time、Simulation step、Draw Callを比較し、終了後は元の人数と再生状態に戻ります。計測中は同じカメラ・シナリオ・品質で比較してください。タブを非表示にすると計測を中止します。

ブラウザが非表示の間はWorkerも停止します。復帰時に経過時間分の計算を積み上げません。

## 実装

- **Simulation**：DOM/WebGPUから独立したCPUのSoA状態。固定30 Hz、読み取り状態と次状態を分離。シード付き乱数。
- **Navigation**：障害物を含む歩行可能グリッドと目的地共有Flow Field。
- **歩行者の出入り**　渋谷では建物5か所の戸口と北へ続く歩道、広場では建物と外周、通路・ボトルネック・交差流では通路の端を歩いて出入りします。1人が退出すると、同じステップで別の出入口から1人が登場します。設定人数は一定で、画面内の人数は視点と人の流れに応じて変わります。追従中の人が退出すると元の視点に戻ります。
- **戸口での合流**　前の人や戸口を横切る人との間に肩幅の余裕を取り、通れる隙間が開くと歩き出します。歩道側の人は空いている側へよけられます。
- **Scramble crossing**：PLATEAU渋谷区2025年度版から切り出した約500m四方・440棟のLOD2建物と道路・歩道。歩行範囲は250m四方、5本の横断歩道・広場の補正は国土地理院の航空写真を参考に設定しています。描画と経路探索は同じ地図を共有し、信号はWorkerのシミュレーション時計で制御します。
- **Avoidance**：Uniform Gridによる近傍探索、目的地誘導、予測回避、速度調整、加速度・旋回速度制限、壁の押し戻し。
- **Worker**：上限付きの固定ステップ更新。Transferable ArrayBufferのプールを使用し、世代番号でリセット前の結果を除外。SharedArrayBuffer / COOP / COEPは不要。
- **Rendering**：WebGPUを直接使用。前後2スナップショットの位置・向き・歩行位相を補間し、requestAnimationFrameで表示。
- **People**：共有プロシージャルメッシュ。頭・髪・胴・腕・脚・靴を生成。体格・肌・服を個体ごとに変化。WGSLの頂点シェーダでIdle / Walk / Runの関節運動を計算。
- **Batching**：画面投影サイズによる3段階LOD、ヒステリシス、Frustum Culling、LODごとのInstance Compaction。人数に比例するDraw Callは発行しません。
- **Environment**：渋谷は事前変換した静的メッシュを同梱。その他のシナリオはプロシージャル生成。Directional / Ambient Lighting、距離フォグ、Instanced Quadの接地影。
- **UI**：HTML/CSS/TypeScriptのみ。実測の統計と非対応時のエラー表示。

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。群集の経路探索・局所回避・信号制御の数式と原典は [アルゴリズム解説](docs/algorithms.html) にまとめています。このHTMLは本番ビルドにも含まれ、GitHub Pagesでは `/fluxity/docs/algorithms.html` で公開できます。

## 計測と性能

目標は1920×1080で60 FPS、CPUシミュレーション30 Hzです。達成を保証するものではありません。実際のFPSは端末、GPU、ブラウザ、ウィンドウサイズ、カメラ、密集度で変わります。

画面の **Frame time** はrequestAnimationFrameの間隔、**CPU render** はカリング・データ転送・コマンドエンコードを含むCPU経過時間、**Simulation step** はWorkerの固定ステップ計算時間です。GPU完了時間とは異なります。GPU timestamp計測は未実装であり、GPU時間を推定表示しません。`timestamp-query` / `indirect-first-instance` 等のオプション機能を要求しません。

`npm run benchmark` はCPUのみの再現可能な測定です。ブラウザ内のBenchmarkは、その時点の描画を含む計測です。高密度のBottleneckでは局所回避の負荷が大きくなるため、広場と分けて比較してください。

2026-11-18のPLATEAU渋谷の実機検証では、1920×1080のブラウザ画面（描画領域1920×1006）/ Balanced / Photo / 青固定で1,000〜20,000人を約120 FPSで描画しました。CPU計算は1,000人で8.32 ms/step、5,000人で37.92 ms/stepでした（各条件4秒の短時間計測）。描画と歩行計算は独立しているため、高いFPSでも30 Hzの歩行計算を維持できるとは限りません。初期人数は1,000人とし、比較時は信号をGreenまたはRedに固定してください。

PLATEAU対応では、実データの経路接続・赤信号・衝突制約・大人数初期化、メッシュの完全性と非同期読み込みを追加検証しています。条件・人数別の数値・スクリーンショット・未検証範囲は [検証記録](docs/validation.md) に記載しています。

## 制約・拡張

- 軽量なSteeringモデルです。厳密なORCAや研究用途の歩行者モデル、物理的に完全な非貫通・群集圧力の保証はありません。過密状態では滞留や重なりが起こり得ます。
- 渋谷ステージの建物・道路はPLATEAU由来で、建物には元データの写真テクスチャを使用します。地面は平面化し、道路・歩道は判読しやすい単色表示です。横断歩道・広場・信号配置はデモ用の補正、信号周期は赤12秒・青35秒です。2025年度版は以前に作成された地物も含み、現在の再開発状況や看板を保証するものではありません。坂道・デッキ・地下・車両のシミュレーションは含みません。赤信号では横断開始を抑止し、横断中の歩行者が車道上で一斉停止しないようにしています。過密時には出口の歩道に滞留が生じ、全員が一定時間内に渡り終える保証はありません。
- Flow Fieldは静的シナリオ用です。動的障害物、NavMesh、個別のA*、マルチフロアは未実装です。
- glTF / スキニング / Animation Texture、GPU Computeによるカリング・シミュレーション、Indirect Draw、正確なGPU timestamp計測は将来の拡張です。
- GPUバッファは最大20,000人向けに確保します。20,000人超への拡張では上限、シミュレーション密度、転送量、カリングを再評価してください。
- WebGPUのDevice loss・初期化失敗・WGSLコンパイル・Validation errorを診断します。Device loss後の自動復旧はせず、再読み込みを案内します。
- 描画とSimulationの境界は数値配列とメッセージのみです。SimulationをRust/WASMへ置き換え、同じSnapshot契約を維持できます。

実行時はアプリと同じ配信元から、渋谷メッシュ・写真画像・貼り付け座標を計約19MB読み込みます。1,606枚の元写真を近傍優先で縮小し、2048×2048の画像5枚（約6.1MB）にまとめています。外部CDN・PLATEAU API・地図画像へのアクセスは不要です。地図・メッシュ・写真データのSHA-256を照合し、異なる版のデータが混在した場合は読み込みエラーにします。

データ取得・再生成・座標系・出典は [PLATEAUデータの説明](docs/plateau-data.md) を参照してください。通常の起動・ビルドはPython不要です。渋谷の派生データはCC BY 4.0で使用し、出典は「3D都市モデル（Project PLATEAU）渋谷区（2025年度）を加工して作成」です。横断歩道等の校正には [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html#seamlessphoto) を参照しています。コードのGPLライセンスとデータの出典・ライセンスは区別しています。

## 仕様参照

- [WebGPU specification](https://www.w3.org/TR/webgpu/)
- [WGSL specification](https://gpuweb.github.io/gpuweb/wgsl/)
- [Shibuya Crossing — Japan National Tourism Organization](https://www.japan.travel/en/spot/2177/)（ステージの着想）

## License

[GNU General Public License v3.0](LICENSE)
