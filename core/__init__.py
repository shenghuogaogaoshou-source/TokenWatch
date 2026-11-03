# -*- coding: utf-8 -*-
"""TokenWatch 核心模块（本地库 / 模型目录 / 路径解析）。

与 server.py 的约定：本包不 import server，避免循环依赖。
所有运行期可写数据都落在 %APPDATA%\\TokenWatch\\，不放 exe 目录。
"""
