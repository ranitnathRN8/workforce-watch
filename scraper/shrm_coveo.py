import os
import json
import requests

COVEO_URL = "https://societyforhumanresourcemanagementproductionay6r644u.org.coveo.com/rest/search/v2"
ORG_ID    = "societyforhumanresourcemanagementproductionay6r644u"

# Base headers: mirror the browser as per your curl
BASE_HEADERS = {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://www.shrm.org",
    "referer": "https://www.shrm.org/",
    "user-agent": "Mozilla/5.0 (HRNewsAgent/1.3; +https://example.org)",
    "dnt": "1",
}

# Your captured payload (you can tweak filters below)
BASE_PAYLOAD = {
    "locale":"en",
    "debug":False,
    "tab":"default",
    "referrer":"default",
    "timezone":"Asia/Calcutta",
    "fieldsToInclude":[
        "author","language","urihash","objecttype","collection","source","permanentid",
        "date","filetype","parents","ec_price","ec_name","ec_description","ec_brand",
        "ec_category","ec_item_group_id","ec_shortdesc","ec_thumbnails","ec_images",
        "ec_promo_price","ec_in_stock","ec_rating","meteredflag","datesortfield",
        "showLockIcon","shrmrecommended","contenttypefiltertag","template","pagename",
        "rollupimage","articleauthor","articletoolcontent","articlesocialtoolenabled",
        "description","docdate","docdatestring","migratedmodifieddate"
    ],
    "q":"",
    "enableQuerySyntax":False,
    "searchHub":"ProdShrmUsSearchPage",
    # Use a date sort for “latest first” (your curl had relevancy + ytlikecount)
    "sortCriteria":"date descending",
    "queryCorrection":{"enabled":True,"options":{"automaticallyCorrect":"never"}},
    "enableDidYouMean":False,
    "facets":[
        # Location facet — India selected (you can change or add more later)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,
            "sortCriteria":"occurrences","resultsMustMatch":"atLeastOneValue",
            "type":"specific",
            "currentValues":[
                {"value":"India","state":"selected"},
                {"value":"California","state":"idle"},
                {"value":"Europe","state":"idle"},
                {"value":"Canada","state":"idle"},
                {"value":"United Kingdom","state":"idle"},
                {"value":"New York","state":"idle"},
                {"value":"Asia","state":"idle"}
            ],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"locationfiltertag","field":"locationfiltertag"
        },
        # Author facet (idle)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,
            "sortCriteria":"occurrences","resultsMustMatch":"atLeastOneValue",
            "type":"specific",
            "currentValues":[
                {"value":"SHRM Advisor","state":"idle"},
                {"value":"Shefali Anand","state":"idle"},
                {"value":"Sumali Nagarajan","state":"idle"},
                {"value":"Rubi Khan","state":"idle"},
                {"value":"Karuna Parmar","state":"idle"},
                {"value":"Anindita Dev","state":"idle"},
                {"value":"Kaizerine Z. Aria","state":"idle"}
            ],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"articleauthor","field":"articleauthor"
        },
        # Content type facet — **News selected** (this is your filter)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,
            "sortCriteria":"occurrences","resultsMustMatch":"atLeastOneValue",
            "type":"specific",
            "currentValues":[
                {"value":"Blog","state":"idle"},
                {"value":"Tools and Samples","state":"idle"},
                {"value":"Toolkit","state":"idle"},
                {"value":"News","state":"selected"},
                {"value":"How-to Guide","state":"idle"},
                {"value":"Research","state":"idle"},
                {"value":"Presentation","state":"idle"}
            ],
            "freezeCurrentValues":True,"isFieldExpanded":False,"preventAutoSelect":True,
            "facetId":"contenttypefiltertag","field":"contenttypefiltertag"
        },
        # Date ranges (leave as-is; you can adjust with explicit range if needed)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":6,
            "sortCriteria":"descending","rangeAlgorithm":"even","resultsMustMatch":"atLeastOneValue",
            "currentValues":[
                {"start":"2025/08/23@18:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"},
                {"start":"2025/08/22@19:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"},
                {"start":"2025/08/16@19:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"},
                {"start":"2025/07/23@19:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"},
                {"start":"2025/05/23@19:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"},
                {"start":"2024/08/23@19:54:37","end":"2025/08/23@19:54:37","endInclusive":False,"state":"idle"}
            ],
            "preventAutoSelect":False,"type":"dateRange","facetId":"docdate","field":"docdate","generateAutomaticRanges":False
        },
        # Auto date inputs used by the UI – safe to keep
        {"filterFacetCount":True,"injectionDepth":1000,"numberOfValues":1,"sortCriteria":"ascending","rangeAlgorithm":"even","resultsMustMatch":"atLeastOneValue","currentValues":[],"preventAutoSelect":False,"type":"dateRange","facetId":"docdate_input_range","generateAutomaticRanges":True,"field":"docdate"},
        {"filterFacetCount":True,"injectionDepth":1000,"numberOfValues":0,"sortCriteria":"ascending","rangeAlgorithm":"even","resultsMustMatch":"atLeastOneValue","currentValues":[],"preventAutoSelect":False,"type":"dateRange","facetId":"docdate_input","field":"docdate","generateAutomaticRanges":False},
        # Topic facet (idle)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,"sortCriteria":"occurrences",
            "resultsMustMatch":"atLeastOneValue","type":"specific",
            "currentValues":[
                {"value":"Employee Engagement","state":"idle"},
                {"value":"Inclusion and Diversity","state":"idle"},
                {"value":"Leadership Development","state":"idle"},
                {"value":"Talent Acquisition","state":"idle"},
                {"value":"Employee Relations","state":"idle"},
                {"value":"Workplace Culture","state":"idle"},
                {"value":"Organizational & Employee Development","state":"idle"}
            ],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"topicfiltertag","field":"topicfiltertag"
        },
        # Audience facet (idle)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,"sortCriteria":"occurrences",
            "resultsMustMatch":"atLeastOneValue","type":"specific",
            "currentValues":[
                {"value":"HR Pro","state":"idle"},
                {"value":"HR Leader","state":"idle"},
                {"value":"HR Executives","state":"idle"},
                {"value":"People Managers","state":"idle"}
            ],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"audiencefiltertag","field":"audiencefiltertag"
        },
        # Publication facet (idle)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,"sortCriteria":"occurrences",
            "resultsMustMatch":"atLeastOneValue","type":"specific",
            "currentValues":[
                {"value":"HR News","state":"idle"},
                {"value":"HR Daily","state":"idle"},
                {"value":"AI + HI","state":"idle"}
            ],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"publicationfiltertag","field":"publicationfiltertag"
        },
        # Subbrands (idle)
        {
            "filterFacetCount":True,"injectionDepth":1000,"numberOfValues":7,"sortCriteria":"occurrences",
            "resultsMustMatch":"atLeastOneValue","type":"specific",
            "currentValues":[],
            "freezeCurrentValues":False,"isFieldExpanded":False,"preventAutoSelect":False,
            "facetId":"subbrandsfiltertag","field":"subbrandsfiltertag"
        }
    ],
    "numberOfResults": 25,
    "firstResult": 0,
    "facetOptions": {"freezeFacetOrder": True}
}

def fetch_shrm_news_via_coveo(count: int = 25):
    token = os.getenv("SHRM_COVEO_TOKEN")
    if not token:
        raise RuntimeError("SHRM_COVEO_TOKEN not set")

    headers = dict(BASE_HEADERS)
    headers["authorization"] = f"Bearer {token}"

    payload = dict(BASE_PAYLOAD)
    payload["numberOfResults"] = count
    # optionally, you can set "firstResult" for pagination

    params = {"organizationId": ORG_ID}

    r = requests.post(COVEO_URL, params=params, headers=headers, data=json.dumps(payload), timeout=30)
    if r.status_code == 401 or r.status_code == 403:
        raise RuntimeError(f"SHRM Coveo auth failed ({r.status_code}). Refresh SHRM_COVEO_TOKEN from DevTools.")
    r.raise_for_status()

    data = r.json()
    items = []
    for res in data.get("results", []):
        title = res.get("title") or ""
        url = res.get("clickUri") or res.get("clickuri") or ""
        snippet = res.get("excerpt") or ""
        raw = res.get("raw", {})
        # Prefer ISO 'date' if present, else raw field
        date = res.get("date") or raw.get("date") or raw.get("docdatestring")
        if title and url:
            items.append({
                "title": title.strip(),
                "url": url.strip(),
                "date": date,
                "snippet": (snippet or "").strip(),
                "raw": raw
            })
    return items
