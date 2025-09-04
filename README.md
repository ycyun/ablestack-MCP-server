# ablestack-mcp-server 

[![mold](https://img.shields.io/badge/ablecloud-orange?style=flat&logo=apachecloudstack&logoColor=white&logoSize=auto&label=mold&labelColor=blue&color=orange&cacheSeconds=1&link=ablecloud.io)](https://ablecloud.io/)

ABLESTACK MOLD API를 MCP(Model Context Protocol)로 노출하는 서버입니다.  
**`mold_*`** 네임스페이스의 MCP 툴을 통해 CloudStack API를 직접 호출·탐색·디버그할 수 있습니다.

---

## 특징

- **연결정보 툴**: `mold_getConfig`, `mold_setConfig` (endpoint/apiKey/secret/algo 저장·조회)
- **범용 호출**: `mold_call` → 임의의 API 호출
- **서명 디버그**: `mold_signDebug` → 정규화 문자열/서명/최종 URL 확인
- **자동 등록**: `mold_autoRegisterApis`, `mold_listApisMeta`  
  `listApis` 메타를 읽어 **모든 API**를 `mold_<API명>` 툴로 동적 등록
- **비동기 폴링**: isAsync API에 `_wait`, `_timeoutMs`, `_intervalMs` 옵션 지원
- **브래킷 표기 변환**: 중첩 params(JSON) → `details[0].cpuNumber=8` 등으로 자동 전개
- **서명 알고리즘 토글**: HMAC-**SHA1**/**SHA256** (서버/클라 동일해야 함)

---

## 요구 사항

- Node.js **v18+**
- 네트워크에서 CloudStack API endpoint에 접근 가능

---

## 설치 & 실행

```bash
# 의존성 설치
npm i

# 실행 (stdio)
node server.js
```

### Claude Desktop(또는 MCP 클라이언트) 연동 예시

`config.json` (클라이언트 설정) 예시:

```json
{
  "mcpServers": {
    "mcp-cloudstack-421": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "CLOUDSTACK_ENDPOINT": "http://10.10.32.10:8080/client/api",
        "CLOUDSTACK_API_KEY": "<YOUR_API_KEY>",
        "CLOUDSTACK_SECRET_KEY": "<YOUR_SECRET_KEY>",
        "CLOUDSTACK_SIG_ALGO": "sha256",   // 또는 "sha1"
        "CLOUDSTACK_AUTOREGISTER": "all"   // (선택) 시작 시 전체 API 자동 등록
      }
    }
  }
}
```

> 실행 후 MCP Inspector/Claude 등에서 툴이 표시됩니다.

---

## 툴 목록(핵심)

| 툴 이름 | 설명 | 입력 예시 |
|---|---|---|
| `mold_getConfig` | 현재 endpoint/apiKey(마스킹)/algo/구성파일 경로 조회 | `{}` |
| `mold_setConfig` | 연결정보 설정 및 저장(persist=true면 디스크 저장) | `{"endpoint":"http://HOST:8080/client/api","apiKey":"...","secret":"...","algo":"sha256","persist":true}` |
| `mold_signDebug` | 서명 디버그(정규화 문자열·서명·최종 URL 생성) | `{"command":"listVirtualMachines","params":{"listall":true}}` |
| `mold_call` | **임의 API 호출**(command + params) | `{"command":"listZones"}` |
| `mold_listApisMeta` | `listApis` 메타 조회(name/isasync/params) | `{}` 또는 `{"name":"deployVirtualMachine"}` |
| `mold_autoRegisterApis` | 모든 API를 MCP 툴로 동적 등록 | `{"include":"^list|^get","exclude":"Deprecated","limit":200}` |
| `mold_<API명>` | 자동 등록된 개별 API 툴(예: `mold_deployVirtualMachine`) | API별 파라미터(아래 표 참고) |

> 자동 등록된 **비동기** API(`isasync=true`)는 `_wait`, `_timeoutMs`, `_intervalMs` 옵션을 추가로 받습니다.

---

## 사용 예시

### 1) 연결정보 설정/확인

```json
// 설정
{"endpoint":"http://10.10.32.10:8080/client/api","apiKey":"...","secret":"...","algo":"sha256","persist":true}

// 조회
{}
```

### 2) 기본 조회

```json
// 존 목록
{"command":"listZones"}

// VM 목록
{"command":"listVirtualMachines","params":{"listall":true}}
```

### 3) 배포(비동기) — `mold_call`

입력(JSON):

```json
{
  "command": "deployVirtualMachine",
  "params": {
    "name": "MySQL-Server2",
    "zoneid": "dbbaf9e7-865a-4c89-8a26-338c66ec2b81",
    "details": { "memory": "16384", "cpuNumber": "8" },
    "networkids": "91a24cde-38e4-494a-ae48-778d683ae735",
    "templateid": "ca990e93-f2c0-4367-9f88-5bbc571e9fac",
    "displayname": "MySQL-Server",
    "serviceofferingid": "362c96c7-2b9c-4414-b9ca-9897da845080",
    "boottype": "UEFI"
  }
}
```

내부 전개(브래킷 표기; 서명 전에 적용):

```
zoneid=...&serviceofferingid=...&details[0].cpuNumber=8&details[0].memory=16384&
networkids=...&name=MySQL-Server2&templateid=...&displayname=MySQL-Server&boottype=UEFI&
command=deployVirtualMachine
```

### 4) 자동 등록된 툴로 바로 호출

```json
// 예: mold_deployVirtualMachine
{
  "serviceofferingid": "362c96c7-2b9c-4414-b9ca-9897da845080",
  "zoneid": "dbbaf9e7-865a-4c89-8a26-338c66ec2b81",
  "templateid": "ca990e93-f2c0-4367-9f88-5bbc571e9fac",
  "name": "MySQL-Server2",
  "details": { "cpuNumber": "8", "memory": "16384" },
  "_wait": true              // 완료까지 폴링
}
```

---

## 파라미터 전개 규칙(브래킷 표기)

| 입력 타입 | 예시 입력 | 전송 형태 |
|---|---|---|
| 원시값 | `"name":"vm01"` | `name=vm01` |
| 원시 배열 | `"securitygroupids":["id1","id2"]` | `securitygroupids=id1,id2` (CSV) |
| 객체(톱레벨) | `"details":{"cpuNumber":"8","memory":"16384"}` | `details[0].cpuNumber=8`, `details[0].memory=16384` |
| 배열-객체 | `"datadisks":[{"size":"50","diskofferingid":"..."},{"size":"100"}]` | `datadisks[0].size=50`, `datadisks[0].diskofferingid=...`, `datadisks[1].size=100` |
| 이미 표기된 키 | `"details[0].cpuNumber":"8"` | 그대로 사용 |

> 복잡한 중첩 객체도 자동으로 전개됩니다. 이미 `details[0].x`와 같이 **브래킷/닷 표기**로 준 키는 수정하지 않습니다.

---

## 환경변수

| 이름 | 의미 | 기본 |
|---|---|---|
| `CLOUDSTACK_ENDPOINT` | `http(s)://HOST:PORT/client/api` | (없음) |
| `CLOUDSTACK_API_KEY` | API 키 | (없음) |
| `CLOUDSTACK_SECRET_KEY` | 시크릿 키 | (없음) |
| `CLOUDSTACK_SIG_ALGO` | `sha1` 또는 `sha256` | `sha256` |
| `CLOUDSTACK_AUTOREGISTER` | `"all"`이면 시작 시 전체 자동 등록 | (비활성) |

> 실행 중에는 `mold_setConfig`로 변경·저장 가능. 저장 파일: `~/.config/mcp-cloudstack/config.json` (파일 권한 `0600`, 디렉터리 `0700`)

---

## 문제 해결(401 서명 오류 체크리스트)

| 증상 | 점검 |
|---|---|
| `User signature [...] is not equaled to computed signature [...]` | 서버/클라 **해시 알고리즘 일치**(SHA1 vs SHA256), 키·시크릿 **공백/개행 제거**, **정규화 문자열**(소문자·키정렬·값 URL 인코딩·공백 `%20`) 확인 |
| 401 계속 | CIDR 제한(`api.allowed.source.cidr.list`) 또는 권한 문제 |
| 일부 API만 실패 | 파라미터 누락/오타, 권한 부족 |

> `mold_signDebug`로 **normalized/URL**을 비교하면 원인을 빨리 찾을 수 있습니다.

---

## 보안

- API/Secret 키는 민감정보입니다. 노출 시 즉시 **재발급(회전)** 하세요.
- stdio 모드에선 **stdout은 프로토콜 전용**, **로그는 stderr**만 사용해야 합니다.

---

## 라이선스

- [LICENSE](LICENSE.md)) 파일을 확인하세요(MIT).

---

## 변경 이력(요약)

- 연결정보 툴 추가(get/set + 디스크 저장)
- `mold_*` 네임스페이스로 툴 이름 정규식 대응
- `listApis` 기반 **자동 도구 등록**
- 비동기 API **폴링 옵션** 지원
- **브래킷 표기 변환기**로 중첩 파라미터 처리
- SHA1/SHA256 서명 알고리즘 토글
