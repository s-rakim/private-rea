cmake_minimum_required(VERSION 3.20)
project(tailchat_cpp VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

find_package(OpenSSL 3.0 REQUIRED)
find_package(CURL REQUIRED)

add_library(tailchat_core STATIC
  src/json.cpp
  src/crypto.cpp
  src/http.cpp
  src/client.cpp)
target_include_directories(tailchat_core PUBLIC src)
target_link_libraries(tailchat_core PUBLIC OpenSSL::Crypto CURL::libcurl)
target_compile_options(tailchat_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(tailchat-cpp src/main.cpp)
target_link_libraries(tailchat-cpp PRIVATE tailchat_core)
target_compile_options(tailchat-cpp PRIVATE -Wall -Wextra -Wpedantic)
install(TARGETS tailchat-cpp)

include(CTest)
if(BUILD_TESTING)
  add_executable(tailchat_unit_tests test/unit_tests.cpp)
  target_link_libraries(tailchat_unit_tests PRIVATE tailchat_core)
  add_test(NAME unit COMMAND tailchat_unit_tests)

  # Interop with the JS web app's crypto.js against a real dev-mode server.
  find_program(NODE_EXECUTABLE node)
  if(NODE_EXECUTABLE)
    add_test(NAME interop
      COMMAND ${NODE_EXECUTABLE} --no-warnings=ExperimentalWarning
              ${CMAKE_CURRENT_SOURCE_DIR}/test/interop.mjs $<TARGET_FILE:tailchat-cpp>)
    set_tests_properties(interop PROPERTIES TIMEOUT 300)
  else()
    message(WARNING "node not found: the interop test is disabled")
  endif()
endif()
