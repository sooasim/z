/**
 * Source-string translations for the languages added after the original Korean/English pair.
 *
 * Screen copy is written inline as `L('검색', 'Search')` in ~2,500 places. Rather than rewrite every call site
 * into a five-way structure, `L` keeps its two arguments and looks the **English** string up here for any other
 * language — the same msgid-keyed approach gettext uses. A phrase that is not in the table renders in English,
 * which is the documented fallback (see docs/I18N.md), so adding a translation never requires touching a screen.
 *
 * Keys must match the English argument of `L(...)` byte for byte, including trailing spaces and ellipsis
 * characters. `apps/web/test/i18n.test.ts` fails when a key here no longer appears in any `L(...)` call, so the
 * table cannot rot silently.
 */
import type { Lang } from './format';

export type TranslatedLang = Exclude<Lang, 'ko' | 'en'>;

type Table = Record<string, string>;

const ja: Table = {
  // ---- structure / navigation
  About: '概要', Account: 'アカウント', Activity: 'アクティビティ', Address: '住所', 'AI assistant': 'AIアシスタント',
  All: 'すべて', Amenities: '設備', Amount: '金額', Approve: '承認', Approved: '承認済み', Area: 'エリア',
  At: '場所', Agreed: '合意済み', 'Add dates': '日程を追加',
  'Back to trips': '旅程に戻る', 'Become a guide': 'ガイドになる', 'Become a host': 'ホストになる',
  Booking: '予約', 'Brand archive': 'ブランドアーカイブ', 'Browse stays': '宿を探す',
  Calendar: 'カレンダー', Cancel: 'キャンセル', 'Cancel booking': '予約をキャンセル', Cancellation: 'キャンセル',
  'Cancellation & refunds': 'キャンセルと返金', 'Cancellation policy': 'キャンセルポリシー',
  'Cancellation terms': 'キャンセル条件', Category: 'カテゴリ', 'Check in': 'チェックイン',
  'Check-in': 'チェックイン', 'Check-out': 'チェックアウト', Checkout: 'お支払い', Choose: '選択',
  'Choose dates': '日程を選択', 'Choose…': '選択…', City: '都市', 'Clear filters': 'フィルターを解除',
  Close: '閉じる', Code: 'コード', Completed: '完了', Compliance: '法令遵守', Confirmed: '確定',
  Date: '日付', Dates: '日程', Decline: '辞退', Departure: '出発', Description: '説明', Details: '詳細',
  'Disputes & safety': '紛争と安全', 'Do it': '実行', Document: '書類', Done: '完了',
  Earnings: '収益', Effective: '適用開始', Email: 'メール', Ends: '終了', Exchange: 'ホーム交換',
  Expires: '有効期限', Filters: 'フィルター', 'Free meetup': '無料で会う', From: '開始',
  'Go home': 'ホームへ', Gross: '総額', Guest: 'ゲスト', Guests: 'ゲスト', Guide: 'ガイド', Guides: 'ガイド',
  'Guide booking': 'ガイド予約', 'Guide session': 'ガイドセッション',
  'Help center': 'ヘルプセンター', 'Help centre': 'ヘルプセンター', Hold: '仮押さえ', Home: 'ホーム',
  'Home exchange': 'ホーム交換', Host: 'ホスト', 'House rules': 'ハウスルール',
  Jurisdiction: '管轄地域', Languages: '言語', Listing: '掲載', Listings: '掲載一覧', 'Log in': 'ログイン',
  'Loading…': '読み込み中…', 'Mark completed': '完了にする', Me: '自分', Message: 'メッセージ',
  'Message host': 'ホストに連絡', Messages: 'メッセージ', Method: '方法', 'My reviews': '自分のレビュー',
  'My trips': '自分の旅程', Name: '名前', Next: '次へ', 'New listing': '新しい掲載',
  'No parties or events': 'パーティー・イベント禁止', 'No pets': 'ペット不可', 'No smoking': '禁煙',
  Notifications: '通知', Open: '開く', Opened: '受付日', 'Open to exchange': '交換受付中', Order: '注文',
  'Our story': '私たちの物語', Paid: '支払済み', Pay: '支払う', 'Pay now': '今すぐ支払う',
  Payment: '決済', Payments: '決済', 'Pets allowed': 'ペット可', Photo: '写真',
  'Photo credits': '写真クレジット', Photos: '写真', 'Plan with AI': 'AIで計画', Previous: '前へ',
  Price: '料金', Product: '商品', Profile: 'プロフィール', Publish: '公開', 'Quiet hours': '静粛時間',
  Rating: '評価', Reason: '理由', Receipt: '領収書', Reconcile: '照合', Refunded: '返金済み',
  Refunds: '返金', Reject: '却下', Report: '報告', 'Report a problem': '問題を報告',
  Requested: '申請日', Requests: 'リクエスト', Reservations: '予約', Resolve: '解決', Resolved: '解決済み',
  Review: 'レビュー', Save: '保存', Saved: '保存済み', 'scroll horizontally': '横にスクロール',
  Search: '検索', Security: 'セキュリティ', 'Security & privacy': 'セキュリティとプライバシー',
  Selected: '選択中', Send: '送信', 'Send request': 'リクエストを送信', Source: '出典', Start: '開始',
  Starts: '開始', Status: 'ステータス', Stay: '宿泊', Stays: '宿', Stories: 'ストーリー',
  Subject: '対象', Submit: '送信', Submitted: '提出済み', Summary: '概要',
  'Their home': '相手の家', Them: '相手', 'their home': '相手の家', 'my home': '自分の家',
  Title: 'タイトル', To: '終了', Total: '合計', Tours: 'ツアー', Traveler: '旅行者',
  'Travel order': '旅行注文', 'Try again': '再試行', Type: '種類', 'Valid until': '有効期限',
  Verification: '本人確認', Verified: '確認済み', Verify: '確認', Version: 'バージョン', View: '表示',
  When: '日時', 'Write a review': 'レビューを書く',
  // ---- fragments that are concatenated into a sentence (leading space is part of the key)
  ' guests': '名', ' (done)': '（完了）', night: '泊', nights: '泊', hr: '時間',
  // ---- home page: the first screen a visitor sees
  'Live a month somewhere new': '一か月、知らない街で暮らす',
  'Where would you like to go?': 'どちらへ行かれますか？',
  'Where will you live next?': '次はどこで暮らしますか？',
  'Cities our members stay in most': 'メンバーが最も長く滞在する街',
  'More destinations': '目的地をもっと見る',
  'Stays you can book now': '今すぐ予約できる宿',
  'Permit-verified homes': '許認可を確認した宿',
  'Homes open to exchange': 'ホーム交換できる家',
  'Swap homes for a month': '一か月、家を交換して暮らす',
  'Local guide friends': 'ローカルガイドフレンド',
  'Friend · Volunteer · Paid · Pro': 'フレンド・ボランティア・有料・プロ',
  'Tours, tickets & packages': 'ツアー・チケット・パッケージ',
  'From verified suppliers': '認証済みの旅行会社から',
  'A club for people who live their travels': '旅を生きる人たちのクラブ',
  'Travel like a local': '暮らすように旅する',
  'Search stays': '宿を検索', 'Search on map': '地図で探す', 'See all': 'すべて見る',
  'List my home for exchange': '自宅を交換に登録', 'Ask the AI assistant': 'AIアシスタントに聞く',
  'Only verified stays are bookable': '確認済みの宿だけ予約できます',
  'Secure payments': '安全な決済', 'Free cancellation': '無料キャンセル',
  'Both homes, confirmed together': '両方の家が同時に確定',
  'Dedicated dispute support': '紛争の専任サポート', 'Our safety promise': '安全への約束',
  'Paid booking opens only after permit and safety checks.': '許認可と安全確認を通過した宿だけが有料予約を開けます。',
  'Learn more': '詳しく見る', 'No reviews yet': 'まだレビューがありません',
  'Coming soon.': '近日公開。', 'This list is unavailable right now.': 'この一覧は現在利用できません。',
  'More tours are on the way': 'ツアーは順次追加されます',
  Reviews: 'レビュー', Response: '返信', Clear: 'クリア', 'Choose a date': '日付を選択',
  'Popular sections': '人気のセクション', Shortcuts: 'ショートカット',
  'Where': 'どこへ',
  'Who': '人数',
  'Check out': 'チェックアウト',
  'Search destinations': '目的地を検索',
  'Seaside workation': '海辺のワーケーション',
  'Coffee & coast': 'コーヒーと海',
  'Local life': '暮らすような日常',
  'Ancient capital': '千年の古都',
  'Digital nomads': 'デジタルノマド',
  'Exchange favourite': 'ホーム交換の人気',
  'A month in Europe': 'ヨーロッパで一か月',
  'Exchange homes are visible to members only.': 'ホーム交換の家は会員のみ閲覧できます。',
  'Log in to view': 'ログインして見る',
  'Month-long home exchange': '一か月のホーム交換',
  'Explore exchange': 'ホーム交換を見る',
  'Charter sharing JETPOOL': 'チャーター共有 JETPOOL',
  'Charter news': 'チャーターの最新情報',
  'Neighbourhood life, not tourist spots. Walk, eat and talk with local friends.': '観光地ではなく、街の日常。地元の友だちと歩き、食べ、語り合う旅。',
  'Meet guide friends': 'ガイドフレンドに会う',
  'Bookings are confirmed after TossPayments approval. We never store card details.': '予約はトスペイメンツの承認後に確定します。カード情報は保存しません。',
  'Jeju': '済州',
  'Busan': '釜山',
  'Seoul': 'ソウル',
  'Gangneung': '江陵',
  'Gyeongju': '慶州',
  'Chiang Mai': 'チェンマイ',
  'Tokyo': '東京',
  'Lisbon': 'リスボン',
};

const zh: Table = {
  About: '关于', Account: '账户', Activity: '动态', Address: '地址', 'AI assistant': 'AI 助手',
  All: '全部', Amenities: '设施', Amount: '金额', Approve: '批准', Approved: '已批准', Area: '区域',
  At: '地点', Agreed: '已达成', 'Add dates': '添加日期',
  'Back to trips': '返回行程', 'Become a guide': '成为向导', 'Become a host': '成为房东',
  Booking: '预订', 'Brand archive': '品牌档案', 'Browse stays': '浏览房源',
  Calendar: '日历', Cancel: '取消', 'Cancel booking': '取消预订', Cancellation: '取消',
  'Cancellation & refunds': '取消与退款', 'Cancellation policy': '取消政策',
  'Cancellation terms': '取消条款', Category: '类别', 'Check in': '入住',
  'Check-in': '入住', 'Check-out': '退房', Checkout: '结账', Choose: '选择',
  'Choose dates': '选择日期', 'Choose…': '选择…', City: '城市', 'Clear filters': '清除筛选',
  Close: '关闭', Code: '代码', Completed: '已完成', Compliance: '合规', Confirmed: '已确认',
  Date: '日期', Dates: '日期', Decline: '拒绝', Departure: '出发', Description: '描述', Details: '详情',
  'Disputes & safety': '纠纷与安全', 'Do it': '执行', Document: '文件', Done: '完成',
  Earnings: '收益', Effective: '生效', Email: '邮箱', Ends: '结束', Exchange: '房屋互换',
  Expires: '到期', Filters: '筛选', 'Free meetup': '免费见面', From: '开始',
  'Go home': '返回首页', Gross: '总额', Guest: '房客', Guests: '房客', Guide: '向导', Guides: '向导',
  'Guide booking': '向导预约', 'Guide session': '向导行程',
  'Help center': '帮助中心', 'Help centre': '帮助中心', Hold: '暂留', Home: '首页',
  'Home exchange': '房屋互换', Host: '房东', 'House rules': '房屋规则',
  Jurisdiction: '管辖地区', Languages: '语言', Listing: '房源', Listings: '房源', 'Log in': '登录',
  'Loading…': '加载中…', 'Mark completed': '标记完成', Me: '我', Message: '消息',
  'Message host': '联系房东', Messages: '消息', Method: '方式', 'My reviews': '我的评价',
  'My trips': '我的行程', Name: '名称', Next: '下一步', 'New listing': '新建房源',
  'No parties or events': '禁止聚会活动', 'No pets': '禁止携带宠物', 'No smoking': '禁止吸烟',
  Notifications: '通知', Open: '打开', Opened: '创建时间', 'Open to exchange': '可互换', Order: '订单',
  'Our story': '我们的故事', Paid: '已支付', Pay: '支付', 'Pay now': '立即支付',
  Payment: '支付', Payments: '支付', 'Pets allowed': '可携带宠物', Photo: '照片',
  'Photo credits': '照片来源', Photos: '照片', 'Plan with AI': '用 AI 规划', Previous: '上一步',
  Price: '价格', Product: '产品', Profile: '个人资料', Publish: '发布', 'Quiet hours': '安静时段',
  Rating: '评分', Reason: '原因', Receipt: '收据', Reconcile: '对账', Refunded: '已退款',
  Refunds: '退款', Reject: '驳回', Report: '举报', 'Report a problem': '举报问题',
  Requested: '申请时间', Requests: '请求', Reservations: '预订', Resolve: '解决', Resolved: '已解决',
  Review: '评价', Save: '保存', Saved: '已保存', 'scroll horizontally': '横向滚动',
  Search: '搜索', Security: '安全', 'Security & privacy': '安全与隐私',
  Selected: '已选择', Send: '发送', 'Send request': '发送请求', Source: '来源', Start: '开始',
  Starts: '开始', Status: '状态', Stay: '住宿', Stays: '房源', Stories: '故事',
  Subject: '对象', Submit: '提交', Submitted: '已提交', Summary: '摘要',
  'Their home': '对方的家', Them: '对方', 'their home': '对方的家', 'my home': '我的家',
  Title: '标题', To: '结束', Total: '合计', Tours: '旅游团', Traveler: '旅客',
  'Travel order': '旅游订单', 'Try again': '重试', Type: '类型', 'Valid until': '有效期至',
  Verification: '身份验证', Verified: '已验证', Verify: '验证', Version: '版本', View: '查看',
  When: '时间', 'Write a review': '写评价',
  ' guests': '位房客', ' (done)': '（已完成）', night: '晚', nights: '晚', hr: '小时',
  'Live a month somewhere new': '换一座城市，住上一个月',
  'Where would you like to go?': '您想去哪里？',
  'Where will you live next?': '下一站住在哪里？',
  'Cities our members stay in most': '会员停留最久的城市',
  'More destinations': '更多目的地',
  'Stays you can book now': '现在可预订的房源',
  'Permit-verified homes': '已核验资质的房源',
  'Homes open to exchange': '可互换的房子',
  'Swap homes for a month': '交换房子，住一个月',
  'Local guide friends': '本地向导朋友',
  'Friend · Volunteer · Paid · Pro': '朋友 · 志愿 · 付费 · 专业',
  'Tours, tickets & packages': '旅游团 · 门票 · 套餐',
  'From verified suppliers': '来自已认证的供应商',
  'A club for people who live their travels': '为把旅行过成生活的人而设的俱乐部',
  'Travel like a local': '像当地人一样旅行',
  'Search stays': '搜索房源', 'Search on map': '在地图上查找', 'See all': '查看全部',
  'List my home for exchange': '登记我的房子用于互换', 'Ask the AI assistant': '询问 AI 助手',
  'Only verified stays are bookable': '只有核验过的房源才能预订',
  'Secure payments': '安全支付', 'Free cancellation': '免费取消',
  'Both homes, confirmed together': '两边的房子同时确认',
  'Dedicated dispute support': '专人处理纠纷', 'Our safety promise': '我们的安全承诺',
  'Paid booking opens only after permit and safety checks.': '通过资质与安全核验后，房源才会开放付费预订。',
  'Learn more': '了解更多', 'No reviews yet': '还没有评价',
  'Coming soon.': '敬请期待。', 'This list is unavailable right now.': '该列表暂时无法显示。',
  'More tours are on the way': '更多旅游团陆续上线',
  Reviews: '评价', Response: '回复', Clear: '清除', 'Choose a date': '选择日期',
  'Popular sections': '热门板块', Shortcuts: '快捷入口',
  'Where': '目的地',
  'Who': '人数',
  'Check out': '退房',
  'Search destinations': '搜索目的地',
  'Seaside workation': '海边办公度假',
  'Coffee & coast': '咖啡与海岸',
  'Local life': '在地生活',
  'Ancient capital': '千年古都',
  'Digital nomads': '数字游民',
  'Exchange favourite': '互换热门',
  'A month in Europe': '在欧洲住一个月',
  'Exchange homes are visible to members only.': '互换房源仅对会员可见。',
  'Log in to view': '登录后查看',
  'Month-long home exchange': '一个月的房屋互换',
  'Explore exchange': '探索房屋互换',
  'Charter sharing JETPOOL': '包机共享 JETPOOL',
  'Charter news': '包机动态',
  'Neighbourhood life, not tourist spots. Walk, eat and talk with local friends.': '不是景点，而是街区的日常。和当地朋友一起走路、吃饭、聊天。',
  'Meet guide friends': '认识向导朋友',
  'Bookings are confirmed after TossPayments approval. We never store card details.': '预订在 TossPayments 完成支付后确认。我们不保存卡号信息。',
  'Jeju': '济州',
  'Busan': '釜山',
  'Seoul': '首尔',
  'Gangneung': '江陵',
  'Gyeongju': '庆州',
  'Chiang Mai': '清迈',
  'Tokyo': '东京',
  'Lisbon': '里斯本',
};

const vi: Table = {
  About: 'Giới thiệu', Account: 'Tài khoản', Activity: 'Hoạt động', Address: 'Địa chỉ',
  'AI assistant': 'Trợ lý AI', All: 'Tất cả', Amenities: 'Tiện nghi', Amount: 'Số tiền',
  Approve: 'Phê duyệt', Approved: 'Đã phê duyệt', Area: 'Khu vực', At: 'Tại', Agreed: 'Đã thống nhất',
  'Add dates': 'Thêm ngày', 'Back to trips': 'Về chuyến đi', 'Become a guide': 'Trở thành hướng dẫn viên',
  'Become a host': 'Trở thành chủ nhà', Booking: 'Đặt chỗ', 'Brand archive': 'Lưu trữ thương hiệu',
  'Browse stays': 'Xem chỗ ở', Calendar: 'Lịch', Cancel: 'Hủy', 'Cancel booking': 'Hủy đặt chỗ',
  Cancellation: 'Hủy', 'Cancellation & refunds': 'Hủy và hoàn tiền',
  'Cancellation policy': 'Chính sách hủy', 'Cancellation terms': 'Điều kiện hủy', Category: 'Danh mục',
  'Check in': 'Nhận phòng', 'Check-in': 'Nhận phòng', 'Check-out': 'Trả phòng', Checkout: 'Thanh toán',
  Choose: 'Chọn', 'Choose dates': 'Chọn ngày', 'Choose…': 'Chọn…', City: 'Thành phố',
  'Clear filters': 'Xóa bộ lọc', Close: 'Đóng', Code: 'Mã', Completed: 'Hoàn tất',
  Compliance: 'Tuân thủ', Confirmed: 'Đã xác nhận', Date: 'Ngày', Dates: 'Ngày', Decline: 'Từ chối',
  Departure: 'Khởi hành', Description: 'Mô tả', Details: 'Chi tiết',
  'Disputes & safety': 'Tranh chấp và an toàn', 'Do it': 'Thực hiện', Document: 'Tài liệu',
  Done: 'Xong', Earnings: 'Thu nhập', Effective: 'Hiệu lực', Email: 'Email', Ends: 'Kết thúc',
  Exchange: 'Trao đổi nhà', Expires: 'Hết hạn', Filters: 'Bộ lọc', 'Free meetup': 'Gặp miễn phí',
  From: 'Từ', 'Go home': 'Về trang chủ', Gross: 'Tổng thu', Guest: 'Khách', Guests: 'Khách',
  Guide: 'Hướng dẫn viên', Guides: 'Hướng dẫn viên', 'Guide booking': 'Đặt hướng dẫn viên',
  'Guide session': 'Buổi hướng dẫn', 'Help center': 'Trung tâm trợ giúp',
  'Help centre': 'Trung tâm trợ giúp', Hold: 'Giữ chỗ', Home: 'Trang chủ',
  'Home exchange': 'Trao đổi nhà', Host: 'Chủ nhà', 'House rules': 'Nội quy',
  Jurisdiction: 'Khu vực pháp lý', Languages: 'Ngôn ngữ', Listing: 'Tin đăng', Listings: 'Tin đăng',
  'Log in': 'Đăng nhập', 'Loading…': 'Đang tải…', 'Mark completed': 'Đánh dấu hoàn tất', Me: 'Tôi',
  Message: 'Tin nhắn', 'Message host': 'Nhắn chủ nhà', Messages: 'Tin nhắn', Method: 'Phương thức',
  'My reviews': 'Đánh giá của tôi', 'My trips': 'Chuyến đi của tôi', Name: 'Tên', Next: 'Tiếp',
  'New listing': 'Tin đăng mới', 'No parties or events': 'Không tiệc hay sự kiện',
  'No pets': 'Không vật nuôi', 'No smoking': 'Không hút thuốc', Notifications: 'Thông báo',
  Open: 'Mở', Opened: 'Đã mở', 'Open to exchange': 'Nhận trao đổi', Order: 'Đơn hàng',
  'Our story': 'Câu chuyện của chúng tôi', Paid: 'Đã trả', Pay: 'Thanh toán',
  'Pay now': 'Thanh toán ngay', Payment: 'Thanh toán', Payments: 'Thanh toán',
  'Pets allowed': 'Cho phép vật nuôi', Photo: 'Ảnh', 'Photo credits': 'Nguồn ảnh', Photos: 'Ảnh',
  'Plan with AI': 'Lập kế hoạch với AI', Previous: 'Trước', Price: 'Giá', Product: 'Sản phẩm',
  Profile: 'Trang cá nhân', Publish: 'Đăng', 'Quiet hours': 'Giờ yên tĩnh', Rating: 'Đánh giá',
  Reason: 'Lý do', Receipt: 'Biên nhận', Reconcile: 'Đối chiếu', Refunded: 'Đã hoàn tiền',
  Refunds: 'Hoàn tiền', Reject: 'Từ chối', Report: 'Báo cáo', 'Report a problem': 'Báo lỗi',
  Requested: 'Đã yêu cầu', Requests: 'Yêu cầu', Reservations: 'Đặt chỗ', Resolve: 'Giải quyết',
  Resolved: 'Đã giải quyết', Review: 'Đánh giá', Save: 'Lưu', Saved: 'Đã lưu',
  'scroll horizontally': 'cuộn ngang', Search: 'Tìm kiếm', Security: 'Bảo mật',
  'Security & privacy': 'Bảo mật và quyền riêng tư', Selected: 'Đã chọn', Send: 'Gửi',
  'Send request': 'Gửi yêu cầu', Source: 'Nguồn', Start: 'Bắt đầu', Starts: 'Bắt đầu',
  Status: 'Trạng thái', Stay: 'Chỗ ở', Stays: 'Chỗ ở', Stories: 'Câu chuyện', Subject: 'Đối tượng',
  Submit: 'Gửi', Submitted: 'Đã gửi', Summary: 'Tóm tắt', 'Their home': 'Nhà của họ', Them: 'Họ',
  'their home': 'nhà của họ', 'my home': 'nhà của tôi', Title: 'Tiêu đề', To: 'Đến',
  Total: 'Tổng', Tours: 'Tour', Traveler: 'Khách du lịch', 'Travel order': 'Đơn du lịch',
  'Try again': 'Thử lại', Type: 'Loại', 'Valid until': 'Có hiệu lực đến',
  Verification: 'Xác minh', Verified: 'Đã xác minh', Verify: 'Xác minh', Version: 'Phiên bản',
  View: 'Xem', When: 'Khi nào', 'Write a review': 'Viết đánh giá',
  ' guests': ' khách', ' (done)': ' (xong)', night: 'đêm', nights: 'đêm', hr: 'giờ',
  'Live a month somewhere new': 'Sống một tháng ở một thành phố khác',
  'Where would you like to go?': 'Bạn muốn đi đâu?',
  'Where will you live next?': 'Bạn sẽ sống ở đâu tiếp theo?',
  'Cities our members stay in most': 'Những thành phố thành viên ở lâu nhất',
  'More destinations': 'Thêm điểm đến',
  'Stays you can book now': 'Chỗ ở có thể đặt ngay',
  'Permit-verified homes': 'Chỗ ở đã xác minh giấy phép',
  'Homes open to exchange': 'Những ngôi nhà nhận trao đổi',
  'Swap homes for a month': 'Đổi nhà trong một tháng',
  'Local guide friends': 'Hướng dẫn viên bản địa',
  'Friend · Volunteer · Paid · Pro': 'Bạn đồng hành · Tình nguyện · Trả phí · Chuyên nghiệp',
  'Tours, tickets & packages': 'Tour, vé và gói dịch vụ',
  'From verified suppliers': 'Từ các nhà cung cấp đã xác minh',
  'A club for people who live their travels': 'Câu lạc bộ của những người sống cùng chuyến đi',
  'Travel like a local': 'Du lịch như người bản địa',
  'Search stays': 'Tìm chỗ ở', 'Search on map': 'Tìm trên bản đồ', 'See all': 'Xem tất cả',
  'List my home for exchange': 'Đăng nhà của tôi để trao đổi', 'Ask the AI assistant': 'Hỏi trợ lý AI',
  'Only verified stays are bookable': 'Chỉ chỗ ở đã xác minh mới đặt được',
  'Secure payments': 'Thanh toán an toàn', 'Free cancellation': 'Hủy miễn phí',
  'Both homes, confirmed together': 'Cả hai nhà được xác nhận cùng lúc',
  'Dedicated dispute support': 'Hỗ trợ tranh chấp riêng', 'Our safety promise': 'Cam kết an toàn',
  'Paid booking opens only after permit and safety checks.': 'Chỗ ở chỉ mở đặt phòng trả phí sau khi qua kiểm tra giấy phép và an toàn.',
  'Learn more': 'Tìm hiểu thêm', 'No reviews yet': 'Chưa có đánh giá',
  'Coming soon.': 'Sắp ra mắt.', 'This list is unavailable right now.': 'Danh sách này hiện không khả dụng.',
  'More tours are on the way': 'Sẽ có thêm nhiều tour',
  Reviews: 'Đánh giá', Response: 'Phản hồi', Clear: 'Xóa', 'Choose a date': 'Chọn ngày',
  'Popular sections': 'Mục phổ biến', Shortcuts: 'Lối tắt',
  'Where': 'Ở đâu',
  'Who': 'Mấy người',
  'Check out': 'Trả phòng',
  'Search destinations': 'Tìm điểm đến',
  'Seaside workation': 'Workation bên biển',
  'Coffee & coast': 'Cà phê và biển',
  'Local life': 'Đời sống bản địa',
  'Ancient capital': 'Cố đô ngàn năm',
  'Digital nomads': 'Dân du mục số',
  'Exchange favourite': 'Được ưa chuộng để trao đổi',
  'A month in Europe': 'Một tháng ở châu Âu',
  'Exchange homes are visible to members only.': 'Nhà trao đổi chỉ hiển thị cho thành viên.',
  'Log in to view': 'Đăng nhập để xem',
  'Month-long home exchange': 'Trao đổi nhà trong một tháng',
  'Explore exchange': 'Khám phá trao đổi nhà',
  'Charter sharing JETPOOL': 'Chia sẻ chuyến bay JETPOOL',
  'Charter news': 'Tin về chuyến bay thuê',
  'Neighbourhood life, not tourist spots. Walk, eat and talk with local friends.': 'Không phải điểm du lịch, mà là nhịp sống khu phố. Đi bộ, ăn uống và trò chuyện cùng bạn bản địa.',
  'Meet guide friends': 'Gặp hướng dẫn viên',
  'Bookings are confirmed after TossPayments approval. We never store card details.': 'Đặt chỗ được xác nhận sau khi TossPayments duyệt. Chúng tôi không lưu thông tin thẻ.',
  'Jeju': 'Jeju',
  'Busan': 'Busan',
  'Seoul': 'Seoul',
  'Gangneung': 'Gangneung',
  'Gyeongju': 'Gyeongju',
  'Chiang Mai': 'Chiang Mai',
  'Tokyo': 'Tokyo',
  'Lisbon': 'Lisbon',
};

export const PHRASES: Record<TranslatedLang, Table> = { ja, zh, vi };

/**
 * Loanwords a language genuinely writes the same way as English. Listed explicitly so the "did someone paste
 * the English in?" check in test/i18n.test.ts keeps its teeth for every other phrase.
 */
export const SAME_AS_ENGLISH: Record<TranslatedLang, readonly string[]> = {
  ja: [],
  zh: [],
  // Vietnamese writes these the same way as English: "Email" is the loanword ("Menu" is the matching case in
  // lib/dict.ts), and these city names stay Latin-script in Vietnamese travel usage.
  vi: ['Email', 'Jeju', 'Busan', 'Seoul', 'Gangneung', 'Gyeongju', 'Chiang Mai', 'Tokyo', 'Lisbon'],
};

/** English `source` rendered in `lang`, or the English itself when the phrase is not translated yet. */
export function translate(source: string, lang: Lang): string {
  if (lang === 'ko' || lang === 'en') return source;
  return PHRASES[lang]?.[source] ?? source;
}

/**
 * Read the localized side of a record authored as `{ ko, en, … }` — the shape used for inline copy tables all
 * over the screens. Korean takes `ko`; any other language takes `en` through the phrase table. Replaces the
 * old `obj[lang]` indexing, which only ever had two keys to choose from.
 */
/**
 * Localize a whole copy object authored as `{ ko: {...}, en: {...} }` — used where a block carries several
 * fields (title/body/cta) instead of one string. Korean returns its own tree; every other language returns the
 * English tree with each string field run through the phrase table.
 */
export function pickBlock<K extends string>(o: { ko: Record<K, string>; en: Record<K, string> }, lang: Lang): Record<K, string> {
  if (lang === 'ko') return o.ko;
  if (lang === 'en') return o.en;
  return Object.fromEntries(Object.entries<string>(o.en).map(([k, v]) => [k, translate(v, lang)])) as Record<K, string>;
}

/**
 * Read the localized side of a `[ko, en]` tuple — the other shape inline copy tables use. Same rule as
 * `pickText`: Korean takes index 0, everything else takes index 1 through the phrase table.
 */
export function pickPair(pair: readonly string[] | undefined | null, lang: Lang): string | undefined {
  // Returns undefined (not '') for a missing pair so call sites keep working with `?? fallback`.
  if (!pair) return undefined;
  return lang === 'ko' ? String(pair[0]) : translate(String(pair[1] ?? pair[0]), lang);
}

export function pickText<K extends string>(o: Record<K | 'ko' | 'en', string> | Record<string, any>, lang: Lang): string {
  const en = String(o.en ?? '');
  // An empty Korean side means "not written yet", not "render nothing" — fall through to English.
  const ko = String(o.ko ?? '');
  return lang === 'ko' ? ko || en : translate(en, lang);
}
