'use client';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

/** Compliance workbench: lodging permits, host applications, guide qualifications, suppliers, travel products, rules. */
export default function AdminComplianceView() {
  const { L } = useI18n();
  const r = (path: string, body: any = {}) => post(path, body);
  return (
    <AdminListPage
      title={L('준수 심사 워크벤치', 'Compliance workbench')}
      subtitle={L('숙소 인허가, 호스트 신청, 유료/전문 가이드 자격, 공급사·상품 등록과 유효기간 규칙을 심사합니다. 모든 결정은 감사 기록됩니다.', 'Review permits, host applications, guide credentials, suppliers/products and effective-dated rules. Every decision is audited.')}
      path="/v1/admin/permits"
      search={false}
      columns={[]}
      tabs={[
        {
          value: 'permits',
          label: L('숙소 인허가', 'Lodging permits'),
          path: '/v1/admin/permits',
          query: { status: 'PENDING' },
          columns: [
            { key: 'propertyTitle|property_title|propertyId', label: L('숙소', 'Property') },
            { key: 'permitType|permit_type', label: L('유형', 'Type') },
            { key: 'permitNo|permit_no', label: L('번호', 'No.') },
            { key: 'jurisdiction', label: L('관할', 'Jurisdiction') },
            { key: 'validUntil|valid_until', label: L('만료', 'Valid until'), kind: 'date' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt|created_at', label: L('제출', 'Submitted'), kind: 'datetime' },
          ],
          actions: [
            { label: L('승인', 'Verify'), tone: 'primary', run: (x) => r(`/v1/admin/permits/${str(x, 'id')}/verify`) },
            { label: L('반려', 'Reject'), tone: 'danger', reason: L('반려 사유 (호스트에게 전달)', 'Reason (sent to host)'), run: (x, reason) => r(`/v1/admin/permits/${str(x, 'id')}/reject`, { reason }) },
          ],
        },
        { value: 'expired', label: L('만료·취소', 'Expired / revoked'), path: '/v1/admin/permits', query: { status: 'EXPIRED' } },
        {
          value: 'hosts',
          label: L('호스트 신청', 'Host applications'),
          path: '/v1/admin/host-applications',
          columns: [
            { key: 'displayName|legalName|userId', label: L('신청자', 'Applicant') },
            { key: 'hostType|host_type', label: L('유형', 'Type') },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt|created_at', label: L('신청', 'Submitted'), kind: 'datetime' },
          ],
          actions: [
            { label: L('승인', 'Approve'), tone: 'primary', when: (x) => ['SUBMITTED', 'PENDING', 'IN_REVIEW'].includes(str(x, 'status').toUpperCase()), run: (x) => r(`/v1/admin/host-applications/${str(x, 'id')}/approve`) },
            { label: L('반려', 'Reject'), tone: 'danger', when: (x) => ['SUBMITTED', 'PENDING', 'IN_REVIEW'].includes(str(x, 'status').toUpperCase()), reason: L('반려 사유', 'Reason'), run: (x, reason) => r(`/v1/admin/host-applications/${str(x, 'id')}/reject`, { reason }) },
          ],
        },
        {
          value: 'guides',
          label: L('가이드 자격', 'Guide qualifications'),
          path: '/v1/admin/guide-qualifications',
          query: { status: 'PENDING' },
          columns: [
            { key: 'guideName|display_name|guideId|user_id', label: L('가이드', 'Guide') },
            { key: 'qualificationType|qualification_type', label: L('서류', 'Document') },
            { key: 'referenceNo|reference_no', label: L('번호', 'Ref') },
            { key: 'validUntil|valid_until', label: L('유효기간', 'Valid until'), kind: 'date' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          ],
          actions: [
            { label: L('승인', 'Verify'), tone: 'primary', run: (x) => r(`/v1/admin/guide-qualifications/${str(x, 'id')}/verify`) },
            { label: L('반려', 'Reject'), tone: 'danger', reason: L('반려 사유', 'Reason'), run: (x, reason) => r(`/v1/admin/guide-qualifications/${str(x, 'id')}/reject`, { reason }) },
          ],
        },
        {
          value: 'suppliers',
          label: L('공급사', 'Suppliers'),
          path: '/v1/admin/suppliers',
          query: { status: 'PENDING' },
          columns: [
            { key: 'name', label: L('상호', 'Name') },
            { key: 'supplierType', label: L('유형', 'Type') },
            { key: 'merchantOfRecord', label: 'MoR' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          ],
          actions: [
            { label: L('승인', 'Approve'), tone: 'primary', run: (x) => r(`/v1/admin/suppliers/${str(x, 'id')}/approve`) },
            { label: L('반려', 'Reject'), tone: 'danger', reason: L('반려 사유', 'Reason'), run: (x, reason) => r(`/v1/admin/suppliers/${str(x, 'id')}/decision`, { decision: 'REJECTED', reason }) },
          ],
        },
        {
          value: 'products',
          label: L('여행 상품 검수', 'Travel products'),
          path: '/v1/admin/travel-products',
          query: { status: 'IN_REVIEW' },
          columns: [
            { key: 'title', label: L('상품', 'Product') },
            { key: 'type', label: L('유형', 'Type') },
            { key: 'seller.name', label: L('판매자', 'Seller') },
            { key: 'basePriceMinor', label: L('기본가', 'Base'), kind: 'money' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          ],
          actions: [
            { label: L('게시', 'Publish'), tone: 'primary', run: (x) => r(`/v1/admin/travel-products/${str(x, 'id')}/publish`, {}) },
            { label: L('반려', 'Reject'), tone: 'danger', reason: L('반려 사유', 'Reason'), run: (x, reason) => r(`/v1/admin/travel-products/${str(x, 'id')}/reject`, { reason }) },
          ],
        },
        {
          value: 'rules',
          label: L('준수 규칙', 'Rules'),
          path: '/v1/admin/compliance/rules',
          columns: [
            { key: 'ruleKey|code|name', label: L('규칙', 'Rule') },
            { key: 'jurisdiction', label: L('관할', 'Jurisdiction') },
            { key: 'effectiveFrom|effective_from', label: L('적용 시작', 'From'), kind: 'date' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          ],
          actions: [
            { label: L('승인', 'Approve'), tone: 'primary', when: (x) => str(x, 'status').toUpperCase() === 'DRAFT', reason: L('사업·법무 승인 근거', 'Business/legal approval reference'), run: (x, reason) => r(`/v1/admin/compliance/rules/${str(x, 'id')}/approve`, { reason }) },
            { label: L('폐기', 'Retire'), tone: 'danger', when: (x) => str(x, 'status').toUpperCase() === 'APPROVED', reason: L('폐기 사유', 'Reason'), run: (x, reason) => r(`/v1/admin/compliance/rules/${str(x, 'id')}/retire`, { reason }) },
          ],
        },
      ]}
    />
  );
}
