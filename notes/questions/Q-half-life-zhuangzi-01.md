---
id: 202602251647
title: "Q-half-life-zhuangzi-01"
created: 2026-02-25
tags:
  - type/question
  - topic/half-life
  - chapter/1-3
  - difficulty/intermediate
  - question-type/calculation
  - source/108-textbook
  - status/draft
chapter: "1-3"
topic_path: "物理學/物理與測量/半衰期"
related_chapters: []
context_header: "考察半衰期概念的類比應用。"
tests_concepts: ["[[半衰期]]"]
answer: "8天；9.7天"
---

# Q-half-life-zhuangzi-01

## 題目

『莊子天下篇』中有言「一尺之棰，日取其半，萬世不竭」。若現在量得其長為1/256尺，則此棰從開始截取，已經過了多少天？
接上題，若現在量得其長為0.0012尺，則此棰從開始截取，已經過了多少天？（log2=0.3010，log3=0.4771）

## 答案

8天；9.7天

## 解析

每日取半→[[半衰期]]=1天
(1) 1/256=(1/2)⁸→經過8天
(2) (1/2)^n=0.0012→2^n=1/0.0012≈833.3
n=log₂833.3=log833.3/log2=(log8.333+2)/0.3010
log8.333≈log(8.333)=log(25/3)=log25-log3=2log5-log3=2(1-log2)-log3=2(0.6990)-0.4771=0.9209
n=(0.9209+2)/0.3010=2.9209/0.3010≈9.7天

## 測試概念

- [[半衰期]] — 半衰期概念的類比與對數計算
