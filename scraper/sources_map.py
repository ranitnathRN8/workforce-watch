
# Stable, URL-pattern-first selectors for multiple HR news sources

SOURCES = [
    # Economic Times HR News
    ("https://hr.economictimes.indiatimes.com/news", "a[href*='/news']"),

    # Indian Express - Human Resources tag
    # ("https://indianexpress.com/about/human-resources/",
    #  "a[href^='https://indianexpress.com/article/']"),

    # SHRM landing pages (server-rendered); we’ll filter by URL later
    # ("https://www.shrm.org/topics-tools/news", "a[href]"),
    # ("https://www.shrm.org/topics-tools/topics", "a[href]"),
    # # keep legacy landing so we can harvest .aspx articles that still exist
    # ("https://www.shrm.org/resourcesandtools/hr-topics/pages/default.aspx",
    #  "a[href]"),
    ("shrm:coveo-news", None),  # special handler


    # AIHR (blog + key subpages)
    ("https://www.aihr.com/blog/",
     "a[href^='https://www.aihr.com/blog/'], a[href^='/blog/']"),
    ("https://www.aihr.com/blog/hr-trends/",
     "a[href^='https://www.aihr.com/blog/'], a[href^='/blog/']"),
    # ("https://www.aihr.com/blog/human-resource-basics/",
    #  "a[href^='https://www.aihr.com/blog/'], a[href^='/blog/']"),
    # ("https://www.aihr.com/blog/human-resources-functions/",
    #  "a[href^='https://www.aihr.com/blog/'], a[href^='/blog/']"),

    # HR Dive
    # ("https://www.hrdive.com/",
    #     "a[href^='https://www.hrdive.com/news/'], a[href^='/news/']"),

    # HR Executive
    # ("https://hrexecutive.com/",
    #  "main a[href^='https://hrexecutive.com/'], main a[href^='/']"),

    # HRMorning
    # ("https://www.hrmorning.com/",
    #  "main h3 a, main h2 a, main a[href*='/articles/']"),
]
