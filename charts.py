import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import itertools
import json

f = open('fiatsim.json')
f1 = open('fiatsim_flashloan.json')

data = json.load(f)
data_flash = json.load(f1)

x = [x["result"]["startingDaiBalance"] for x in data]
y = [(y["result"]["finalAPY"] * 100) for y in data]

plt.plot(x, y)
plt.title('APR per DAI')
plt.xlabel('Starting Dai Balance')
plt.ylabel('APR %')
plt.show()

x1 = [x["result"]["startingDaiBalance"] for x in data_flash]
y1 = [(y["result"]["finalAPY"] * 100) for y in data_flash]

plt.plot(x1, y1)
plt.title('APR per DAI with flash loan')
plt.xlabel('Starting Dai Balance')
plt.ylabel('APR %')
plt.show()

max_value = max(y)
max_index = y.index(max_value)

max_result = data[max_index]["result"]
df = pd.DataFrame([max_result])
print(df.to_markdown())
df.to_html('max_result.html')

results = [x["result"] for x in data]
flash_loan_results = [x["result"] for x in data_flash]

cycles_grouping = [x["cycles"] for x in data]
cycles = list(itertools.chain.from_iterable(cycles_grouping))

aggregates_grouping = [x["aggregateCycles"] for x in data]
aggregates = list(itertools.chain.from_iterable(aggregates_grouping))

df = pd.DataFrame(results)
df.to_html('results.html')

df1 = pd.DataFrame(cycles)
df1.to_html('cycles.html')

df2 = pd.DataFrame(aggregates)
df2.to_html('aggregates.html')

df3 = pd.DataFrame(flash_loan_results)
df3.to_html('flashloan_results.html')

f.close()
