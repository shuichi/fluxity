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

3D描画にはWebGPU対応のGPUとブラウザが必要です。Windows/macOSではハードウェアアクセラレーションを有効にしたChromeまたはEdge、MacではSafari 26以降が利用できます。`localhost` / `127.0.0.1` またはHTTPSで開いてください。[SafariのWebGPU対応について](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#webgpu)

## デスクトップへのインストールとオフライン利用

オンラインで本番版のトップページを開き、使っているブラウザからFluxityを追加します。ローカルで試す場合は `npm run build` の後に `npm run preview` を実行し、表示されたURLを開いてください。

- **MacのSafari**（macOS Sonoma 14以降）では「ファイル」→「Dockに追加」を選びます。SafariとWebアプリは保存領域が別なので、追加したらオンラインのままDockからFluxityを一度開いてください。[Appleの手順](https://support.apple.com/ja-jp/104996)
- **Chrome**では、右上の「︙」→「キャスト、保存、共有」→「ページをアプリとしてインストール」を選びます。[Googleの手順](https://support.google.com/chrome/answer/9658361?hl=ja)

アプリの画面右上に **Ready for offline use** と表示されたら準備完了です。次回からはネット接続がなくても起動でき、全5シナリオ、渋谷の写真表示、アルゴリズム解説と比較動画を利用できます。初回に保存するデータは約57 MBです。**Offline setup incomplete** と表示された場合は、接続と端末の空き容量を確認して再読み込みしてください。

オンラインでアプリを開いたときや、画面に戻ったときに新版を確認します。保存が終わると右上に **Update available** が表示されます。現在のシミュレーションを終了してよいタイミングで **Update & reload** を押してください。ほかにFluxityや解説ページを開いている場合は、それらを閉じてからもう一度押します。更新ボタンがない旧版では、オンラインで開いてからFluxityのタブ・解説ページ・アプリをすべて終了し、開き直してください。

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
- 渋谷の **Crossing scene** で Ordinary（通常）、Runner（走者）、Selfie（自撮り）、Group（同行者）、Mixed（混合）を選べます。標準は Mixed / Enhanced です。**Walking model** を切り替えると同じ初期配置と出演者で再開します。Enhanced では **Density-guided entry** が初期設定でオンになり、密度と対向流に応じて横断歩道に入る位置を選びます。オフにして同じシードで歩き方を比べられます。
- **Track participant** を押すと、選んだ場面の走者・撮影者・同行者を近くから追えます。もう一度押すと追跡を終了します。[比較映像と計測結果](docs/results/shibuya-crossing-behavior.md)
- ShibuyaのBuilding appearance：**Photo / Solid**。PLATEAUの写真表示と単色表示を、歩行者の状態を維持したまま切り替えます。
- 渋谷の **Traffic signals** では、**Auto**（自動切替）、**Walk**（歩行者）、**E–W**（東西の車）、**N–S**（南北の車）、**All red**（全赤）を選べます。手動操作は次に通す方向の指定です。街頭の灯器と操作パネルには、実際にその時点で有効な信号が表示されます。一時停止中も指定でき、再生すると切り替えに必要な時間が進みます。
- 渋谷の横断歩道では、縁石に着く前から左右に分かれます。同じ方向の人は横断歩道の幅を使って並んで歩き、向かいから人が来ると、それぞれの進行方向の右側を多く使います。人を避けるときは、横断歩道の縁から最大0.8 mの範囲を使えます。
- 信号表示では、歩行者・東西の車・南北の車の灯色、次の切り替えまでのシミュレーション秒数、歩行者の待機人数と横断人数を確認できます。
- Simulation speed、Walking speed、Avoidance：実行中に調整可能。
- Seed：再現可能な初期配置・外観・目的地選択。
- Quality：解像度とLODのプリセット。Debug：描画診断。
- 詳細統計：可視人数、LODごとの人数、Draw Call、三角形数、CPU描画準備時間、描画解像度。
- Benchmark：4つの人数を順に**2秒ウォームアップ＋4秒計測**。FPS、Frame time、Simulation step、Draw Callを比較し、終了後は元の人数と再生状態に戻ります。計測中は同じカメラ・シナリオ・品質で比較してください。タブを非表示にすると計測を中止します。

ブラウザが非表示の間はWorkerも停止します。復帰時に経過時間分の計算を積み上げません。

## 渋谷駅前の信号

歩行者用は上が赤の停止人形、下が青の歩行人形です。5本の横断歩道が一斉に青になり、斜め方向も渡れます。青点滅からは縁石で待ち、すでに横断中の人は位置に応じて渡り切るか引き返します。車両用の横三灯は運転者から見て左から青・黄・赤です。黄に変わった時点で安全に止まれる車は停止線の手前で止まり、安全に止まれない車は交差点を通過します。[道路交通法施行令第2・3条](https://laws.e-gov.go.jp/law/335CO0000000270) · [警察庁「歩車分離式信号に関する指針」](https://www.npa.go.jp/laws/notification/koutuu/kisei/kisei20250131.pdf) · [東京観光公式サイトの渋谷駅前の写真・解説](https://www.gotokyo.org/jp/story/walks-and-tours/shibuya/index.html)

自動切替の基準は、2020年8月25日18時ごろに渋谷駅前で観測された140秒周期です。各行に示す方向が青の間、ほかの方向は赤です。全赤の最短時間が過ぎても、横断中の人や交差点を抜け切っていない車があれば、全赤を延長します。[渋谷駅前の現地観測記録](https://www.shingou-saikuru.com/2019/01/shibuya-sta.html) · [渋谷駅前の信号制御を扱った研究](https://www.jstage.jst.go.jp/article/pjsai/JSAI2022/0/JSAI2022_3N3GS1003/_pdf/-char/ja)

| 通行順 | 青 | 切り替え時の灯色 | 全赤の最短時間 |
| --- | --- | --- | --- |
| 歩行者 | 37秒 | 青点滅10秒 | 4秒 |
| 東西の車 | 44秒 | 黄3秒 | 3秒 |
| 南北の車 | 33秒 | 黄3秒 | 3秒 |

## 実装

- **Simulation**：DOM/WebGPUから独立したCPUのSoA状態。固定30 Hz、読み取り状態と次状態を分離。シード付き乱数。
- **Navigation**：障害物を含む歩行可能グリッドと目的地共有Flow Field。
- **ハチ公口の歩道と駅広場**　同じ目的地へ向かう複数の経路で、道幅と前方の混雑・対向流を比較します。横断口が混むと後続は広場側でも信号を待ち、青で元の横断歩道へ進みます。標準の渋谷シーンで有効です。[ハチ公口の人流比較](docs/results/shibuya-forecourt.md)
- **歩行者の出入り**　渋谷では沿道50か所の戸口と10か所の街路端を使い、通り抜け・店への訪問・店から街路へ向かう旅程を選びます。広場では建物と外周、通路・ボトルネック・交差流では通路の端を歩いて出入りします。1人が退出すると、同じステップで別の出入口から1人が登場します。設定人数は一定で、画面内の人数は視点と人の流れに応じて変わります。追従中の人が退出すると元の視点に戻ります。[渋谷の地点別の比較結果](docs/results/shibuya-destinations.md)
- **戸口での合流**　渋谷の建物では、戸口の幅に応じて入店と出店に使うレーンを配置します。入る人は手前の空いた列を使えます。新しい歩行者の出場口は、歩道へ合流しやすい場所を優先します。通行人は空いた戸口の前をそのまま通過します。歩道へ出てくる人がいて進路が重なる場合に、その人に道を譲ります。[渋谷全域での滞留と通過人数の比較](docs/results/shibuya-sidewalk-flow.md)
- **出入口での譲り合い**　渋谷の戸口や街路端では、歩行者が前方に見える相手の動きから進路が重なるかを判断します。通り始めた人を先に通すため、歩道上の人が脇へ一歩よけたり、短く立ち止まったりします。
- **店舗前の待ち方**　入店する人は、歩道で前の人が止まると一歩分を空けて待ちます。戸口へ斜めに並ぶときは、店から出る人が歩道へ出られるように進路を空けます。
- **Scramble crossing**：PLATEAU渋谷区2025年度版から切り出した約500m四方・440棟のLOD2建物と道路・歩道。歩行範囲は250m四方、5本の横断歩道・広場の補正は国土地理院の航空写真を参考に設定しています。描画と経路探索は同じ地図を共有し、信号はWorkerのシミュレーション時計で制御します。
- **渋谷の自動車**　東西・南北の車道に沿って左側を直進し、空いている区間では車ごとに20〜30 km/hの巡航速度を目指します。車は前方の車との間隔を保ち、停止線へ向けて減速し、前が空くと順に加速します。横断を始める前の歩行者は縁石で車を待ち、すでに横断中の人がいれば車が待ちます。
- **Avoidance**：Uniform Gridによる近傍探索、目的地誘導、予測回避、速度調整、加速度・旋回速度制限、壁の押し戻し。
- **歩行者のしぐさ**　信号を待つ人は、ときどき信号や横を通る人に顔を向けます。目的地までの距離が近い二つの道があると、一部の人が少し足をゆるめて別の道を見ます。対向者には左右の空きと減速を比べて対応し、実際に身体が触れたときは接近速度に応じて上体を引きます。Streetでは足と顔を一緒に観察でき、人物をクリックするとその人が見た方向を追えます。
- **Worker**：上限付きの固定ステップ更新。Transferable ArrayBufferのプールを使用し、世代番号でリセット前の結果を除外。SharedArrayBuffer / COOP / COEPは不要。
- **Rendering**：WebGPUを直接使用。前後2スナップショットの位置・向き・歩行位相を補間し、requestAnimationFrameで表示。
- **People**：共有プロシージャルメッシュ。頭・髪・胴・腕・脚・靴を生成。体格・肌・服を個体ごとに変化。WGSLの頂点シェーダでIdle / Walk / Runの関節運動を計算。
- **Batching**：画面投影サイズによる3段階LOD、ヒステリシス、Frustum Culling、LODごとのInstance Compaction。人数に比例するDraw Callは発行しません。
- **Environment**：渋谷は事前変換した静的メッシュを同梱。その他のシナリオはプロシージャル生成。Directional / Ambient Lighting、距離フォグ、Instanced Quadの接地影。
- **UI**：HTML/CSS/TypeScriptのみ。実測の統計と非対応時のエラー表示。

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。群集の経路探索・局所回避・信号制御の数式と原典は [アルゴリズム解説](docs/algorithms.html) にまとめています。このHTMLは本番ビルドにも含まれ、GitHub Pagesでは `/fluxity/docs/algorithms.html` で公開できます。

## 実寸の基準

渋谷の車・人・建物は、東西・南北・高さのすべてで **1ワールド単位＝1 m** として、同じカメラで描画します。

| 対象 | モデルの寸法と根拠 |
| --- | --- |
| 自動車 | カローラ スポーツ G（2WD）を基準に、全長4.375 m、車体幅1.790 m、全高1.460 m、ホイールベース2.640 m。走行中の接触判定には左右のミラーを含む全幅2.080 mを使います。[トヨタ主要諸元表](https://toyota.jp/pages/contents/corollasport/001_p_001/pdf/corollasport_spec_202607.pdf) · [ミラーを含む寸法](https://toyota.jp/faq/show/11674.html) |
| 人物 | 基準体格は立ったときの身長1.650 m、目の高さ1.535 m、左右の肩の外側までの幅0.433 m。産総研が1991–92年に計測した日本人の青年男女を合わせた中央値を参考にし、個々の歩行者には体格差を持たせています。[AIST人体寸法データベース](https://www.airc.aist.go.jp/dhrt/91-92/) · [身長](https://www.airc.aist.go.jp/dhrt/91-92/data/gif/B1.gif) · [内眼角高](https://www.airc.aist.go.jp/dhrt/91-92/data/gif/B2.gif) · [肩幅](https://www.airc.aist.go.jp/dhrt/91-92/data/gif/D2.gif) |
| 建物 | 渋谷の440棟はPLATEAUの建物形状を使用し、各棟の最下点が路面に合うよう高さ方向に平行移動します。他のシナリオはメートル単位で設計した架空の街並みです。[PLATEAUの座標と高さ](https://www.mlit.go.jp/plateau/learning/tpc03-4/) · [渋谷の建物寸法の検証](docs/plateau-data.md#対象範囲と座標) |

## 計測と性能

目標は1920×1080で60 FPS、CPUシミュレーション30 Hzです。達成を保証するものではありません。実際のFPSは端末、GPU、ブラウザ、ウィンドウサイズ、カメラ、密集度で変わります。

画面の **Frame time** はrequestAnimationFrameの間隔、**CPU render** はカリング・データ転送・コマンドエンコードを含むCPU経過時間、**Simulation step** はWorkerの固定ステップ計算時間です。GPU完了時間とは異なります。GPU timestamp計測は未実装であり、GPU時間を推定表示しません。`timestamp-query` / `indirect-first-instance` 等のオプション機能を要求しません。

`npm run benchmark` はCPUのみの再現可能な測定です。ブラウザ内のBenchmarkは、その時点の描画を含む計測です。高密度のBottleneckでは局所回避の負荷が大きくなるため、広場と分けて比較してください。

2026-11-18のPLATEAU渋谷の実機検証では、1920×1080のブラウザ画面（描画領域1920×1006）/ Balanced / Photo / 青固定で1,000〜20,000人を約120 FPSで描画しました。CPU計算は1,000人で8.32 ms/step、5,000人で37.92 ms/stepでした（各条件4秒の短時間計測）。描画と歩行計算は独立しているため、高いFPSでも30 Hzの歩行計算を維持できるとは限りません。初期人数は1,000人とし、現在の版で比較するときは、通行させる方向を指定し、信号が切り替わってから計測してください。

PLATEAU対応では、実データの経路接続・赤信号・衝突制約・大人数初期化、メッシュの完全性と非同期読み込みを追加検証しています。条件・人数別の数値・スクリーンショット・未検証範囲は [検証記録](docs/validation.md) に記載しています。

## 制約・拡張

- 軽量なSteeringモデルです。厳密なORCAや研究用途の歩行者モデル、物理的に完全な非貫通・群集圧力の保証はありません。過密状態では滞留や重なりが起こり得ます。
- 渋谷ステージの建物・道路はPLATEAU由来で、建物には元データの写真テクスチャを使用します。地面は平面化し、交差点と接続道路には空中写真に合わせた路面標示と色付き舗装を描画します。横断歩道・広場・車線・灯器の位置は地図に合わせて設定したモデルです。各方向の信号時間には上記の観測値を使います。2025年度版は以前に作成された地物も含み、現在の再開発状況や看板を保証するものではありません。歩行と走行は地上の同一平面で計算します。過密時には出口の歩道に滞留が生じ、交差点が空くまで車が長く待つ場合があります。
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
