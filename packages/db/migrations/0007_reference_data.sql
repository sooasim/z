-- 0007 deterministic reference data (G2: seed data deterministic). No legal/tax rule is APPROVED here.
INSERT INTO amenities(code, category, label_ko, label_en) VALUES
 ('wifi','essentials','와이파이','Wi-Fi'),
 ('kitchen','essentials','주방','Kitchen'),
 ('washer','essentials','세탁기','Washer'),
 ('dryer','essentials','건조기','Dryer'),
 ('aircon','climate','에어컨','Air conditioning'),
 ('heating','climate','난방','Heating'),
 ('ondol','climate','온돌','Ondol floor heating'),
 ('parking','facilities','주차','Free parking'),
 ('elevator','facilities','엘리베이터','Elevator'),
 ('workspace','facilities','업무 공간','Dedicated workspace'),
 ('tv','entertainment','TV','TV'),
 ('pool','facilities','수영장','Pool'),
 ('bbq','outdoor','바비큐 그릴','BBQ grill'),
 ('garden','outdoor','정원','Garden'),
 ('crib','family','유아 침대','Crib'),
 ('smoke_alarm','safety','화재경보기','Smoke alarm'),
 ('fire_extinguisher','safety','소화기','Fire extinguisher'),
 ('first_aid','safety','구급상자','First aid kit'),
 ('self_checkin','access','셀프 체크인','Self check-in'),
 ('wheelchair','access','휠체어 접근','Wheelchair accessible');

INSERT INTO cancellation_policies(code, name, tiers, service_fee_refundable) VALUES
 ('FLEXIBLE','유연 (Flexible)','[{"min_hours_before":24,"refund_pct":100},{"min_hours_before":0,"refund_pct":0}]', false),
 ('MODERATE','보통 (Moderate)','[{"min_hours_before":120,"refund_pct":100},{"min_hours_before":24,"refund_pct":50},{"min_hours_before":0,"refund_pct":0}]', false),
 ('STRICT','엄격 (Strict)','[{"min_hours_before":336,"refund_pct":100},{"min_hours_before":168,"refund_pct":50},{"min_hours_before":0,"refund_pct":0}]', false);

INSERT INTO feature_flags(flag_key, description, enabled) VALUES
 ('charter.direct_booking','JET-01 paid charter/flight-share direct booking (requires G9 legal approval)', false),
 ('travel.commerce','TRAVEL-01..04 tours/tickets/packages sales', false),
 ('guide.paid','Paid/Professional guide bookings (requires G9 paid-guide eligibility approval)', false),
 ('stay.paid_booking','Paid accommodation booking (requires G9 accommodation eligibility approval)', false),
 ('exchange.enabled','Home Exchange flows (requires G9 legal classification approval)', false),
 ('ai.assistant','AI travel assistant', false),
 ('ai.recommendations','Personalized recommendation rails', false),
 ('payout.automatic','Automatic payout execution (manual approval otherwise)', false),
 ('integrations.pms','PMS / iCal integrations', false);

INSERT INTO consent_documents(consent_type, version, title, body_md, required, published_at) VALUES
 ('TERMS','2026-10-draft','JETPOOL 서비스 이용약관 (초안)','법무 검토 후 게시 (G9).', true, NULL),
 ('PRIVACY','2026-10-draft','개인정보 처리방침 (초안)','법무 검토 후 게시 (G9).', true, NULL),
 ('MARKETING','2026-10-draft','마케팅 정보 수신 동의','선택 동의', false, NULL),
 ('EXCHANGE_TERMS','2026-10-draft','Home Exchange 약정 (초안)','법무 검토 후 게시 (G9).', true, NULL),
 ('GUIDE_TERMS','2026-10-draft','Guide Friend 이용 조건 (초안)','법무 검토 후 게시 (G9).', true, NULL),
 ('REFUND_POLICY','2026-10-draft','취소·환불 정책 (초안)','법무 검토 후 게시 (G9).', true, NULL);

INSERT INTO retention_jobs(data_class, retention_days) VALUES
 ('auth_challenges', 7), ('sessions_revoked', 90), ('analytics_events', 730), ('idempotency_keys', 30);
