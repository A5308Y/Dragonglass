module Gtd.ProjectStatus exposing
    ( ProjectStatus(..)
    , all
    , board
    , decoder
    , defaultColumns
    , encode
    , isOpen
    , key
    , label
    )

{-| The closed set of statuses a Project file may carry.

Import this qualified — `import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)` —
so that `ProjectStatus.Cancelled` never collides with the Action status of the same name.

-}

import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type ProjectStatus
    = Active
    | Backlog
    | Someday
    | Completed
    | Cancelled


{-| Every status.
-}
all : List ProjectStatus
all =
    [ Active, Backlog, Someday, Completed, Cancelled ]


{-| The statuses the Projects board can lay out as columns, in order: all of them.
-}
board : List ProjectStatus
board =
    all


{-| The columns shown until the person picks their own; Cancelled is there to switch on.
-}
defaultColumns : List ProjectStatus
defaultColumns =
    [ Active, Backlog, Someday, Completed ]


key : ProjectStatus -> String
key status =
    case status of
        Active ->
            "active"

        Backlog ->
            "backlog"

        Someday ->
            "someday"

        Completed ->
            "completed"

        Cancelled ->
            "cancelled"


label : ProjectStatus -> String
label status =
    case status of
        Active ->
            "Active"

        Backlog ->
            "Backlog"

        Someday ->
            "Someday/Maybe"

        Completed ->
            "Completed"

        Cancelled ->
            "Cancelled"


isOpen : ProjectStatus -> Bool
isOpen status =
    status /= Completed && status /= Cancelled


decoder : Decoder ProjectStatus
decoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case List.filter (\candidate -> key candidate == raw) all of
                    found :: _ ->
                        Decode.succeed found

                    [] ->
                        Decode.fail ("Unknown Project status: " ++ raw)
            )


encode : ProjectStatus -> Encode.Value
encode =
    key >> Encode.string
